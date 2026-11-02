import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import {
  BackgroundState,
  SessionStatus,
  type GitInfo,
  type Session,
  type SessionSnapshot,
  type TmuxLocation,
} from "@switchboard/protocol";
import { listAgents, listAgentsFromFile, type AgentsResult, type RawAgent } from "./agents.ts";
import { AgentSource, listAgentsFromRegistry } from "./source.ts";
import { cachedGitInfo } from "./git.ts";
import { PROC_START_COMPARABLE, ancestry, readStat, type ProcStat } from "./proc.ts";
import { readRegistryFile, sessionsDir, type RegistryFileInfo } from "./registryFile.ts";
import { listPanes, type Pane, type PanesResult } from "./tmux.ts";

export type RegistryDeps = {
  listAgents(): Promise<AgentsResult & { source?: "registry" | "agents" }>;
  listPanes(): Promise<PanesResult>;
  readStat(pid: number): Promise<ProcStat | null>;
  readRegistryFile(pid: number): Promise<RegistryFileInfo | null>;
  gitInfo(cwd: string): Promise<GitInfo | null>;
};

/**
 * 기본 의존성. 환경변수로 바꿀 수 있다(테스트에서 실제 세션을 건드리지 않기 위해):
 * - SWITCHBOARD_AGENTS_FILE: `claude agents --json` 대신 읽을 파일
 * - SWITCHBOARD_TMUX_SOCKET: 격리된 tmux 서버(`tmux -L`)
 */
export function defaultDeps(bins: { claudeBin?: string; tmuxBin?: string } = {}, env: NodeJS.ProcessEnv = process.env): RegistryDeps {
  const agentsFile = env.SWITCHBOARD_AGENTS_FILE;
  const socket = env.SWITCHBOARD_TMUX_SOCKET;
  // 평소엔 레지스트리 파일, 공식 명령은 5분마다(source.ts)
  const source = new AgentSource({
    official: () => (agentsFile ? listAgentsFromFile(agentsFile) : listAgents(bins.claudeBin)),
    files: () => listAgentsFromRegistry(sessionsDir(), readStat, PROC_START_COMPARABLE),
  });
  return {
    listAgents: () => source.list(),
    listPanes: () => listPanes(bins.tmuxBin ?? "tmux", socket),
    readStat,
    readRegistryFile: (pid) => readRegistryFile(pid),
    gitInfo: cachedGitInfo(),
  };
}

function toLocation(pane: Pane, via: TmuxLocation["via"]): TmuxLocation {
  return {
    session: pane.session,
    windowId: pane.windowId,
    windowIndex: pane.windowIndex,
    paneId: pane.paneId,
    paneCommand: pane.command,
    inMode: pane.inMode,
    via,
  };
}

/**
 * 세션 pid가 들어 있는 tmux pane을 찾는다.
 * 1) pid 계보 중 하나가 pane_pid와 같으면 그 pane (셸 경유: claude → bash = pane_pid, 직접 실행: claude = pane_pid)
 * 2) 아니면 내부 레지스트리 파일의 tmux 필드. 이때 procStart가 일치해야 한다(pid 재사용 방지).
 */
export function locatePane(
  chain: readonly ProcStat[],
  panes: readonly Pane[],
  registryFile: RegistryFileInfo | null,
): TmuxLocation | undefined {
  const byPid = new Map(panes.map((p) => [p.panePid, p]));
  for (const proc of chain) {
    const pane = byPid.get(proc.pid);
    if (pane) return toLocation(pane, "ancestry");
  }
  const self = chain[0];
  const hint = registryFile?.tmux;
  if (!self || !hint) return undefined;
  if (PROC_START_COMPARABLE && registryFile.procStart && registryFile.procStart !== self.startTime) return undefined;
  const pane = panes.find((p) => p.paneId === hint.paneId && p.session === hint.session);
  return pane ? toLocation(pane, "registry-file") : undefined;
}

/** 띄운 곳: VS Code 확장(entrypoint claude-vscode) / 터미널(cli 또는 tmux 안) / 그 밖(SDK 등). */
export function surfaceOf(entrypoint: string | undefined, tmux: TmuxLocation | undefined): Session["surface"] {
  if (entrypoint === "claude-vscode") return "vscode";
  if (tmux || entrypoint === "cli" || entrypoint === undefined) return "terminal";
  return "other";
}

function sessionKey(agent: RawAgent): string {
  if (agent.sessionId) return agent.sessionId;
  if (agent.pid !== undefined) return `pid:${agent.pid}`;
  if (agent.id) return `bg:${agent.id}`;
  return `cwd:${agent.cwd}:${agent.startedAt}`;
}

async function toSession(agent: RawAgent, panes: readonly Pane[], deps: RegistryDeps): Promise<Session> {
  const kind = agent.kind === "background" ? "background" : "interactive";
  const status = SessionStatus.safeParse(agent.status);
  const bgState = BackgroundState.safeParse(agent.state);
  const git = (await deps.gitInfo(agent.cwd)) ?? undefined;

  let procStart: string | undefined;
  let tmux: TmuxLocation | undefined;
  let alive = false;
  let entrypoint: string | undefined;
  if (agent.pid !== undefined) {
    const chain = await ancestry(agent.pid, deps.readStat);
    alive = chain.length > 0;
    procStart = chain[0]?.startTime;
    if (alive) {
      const file = await deps.readRegistryFile(agent.pid);
      // pid가 재사용됐으면 그 파일은 다른 프로세스 것
      if (!file?.procStart || !PROC_START_COMPARABLE || file.procStart === procStart) entrypoint = file?.entrypoint;
      tmux = locatePane(chain, panes, file);
    }
  }
  const surface = surfaceOf(entrypoint, tmux);
  const vscode = surface === "vscode" && kind === "interactive" && alive && Boolean(agent.sessionId);

  let notDispatchableReason: Session["notDispatchableReason"];
  if (kind === "background") notDispatchableReason = "background";
  else if (!alive) notDispatchableReason = "not-alive";
  else if (!tmux && !vscode) notDispatchableReason = "no-tmux";

  return {
    key: sessionKey(agent),
    sessionId: agent.sessionId,
    name: agent.name ?? agent.id ?? agent.sessionId?.slice(0, 8) ?? "(unnamed)",
    kind,
    cwd: agent.cwd,
    startedAt: agent.startedAt,
    pid: agent.pid,
    procStart,
    status: status.success ? status.data : undefined,
    waitingFor: agent.waitingFor,
    backgroundId: agent.id,
    backgroundState: bgState.success ? bgState.data : undefined,
    git,
    tmux,
    dispatchable: notDispatchableReason === undefined,
    notDispatchableReason,
    surface,
    ...(notDispatchableReason === undefined ? { delivery: tmux ? ("tmux" as const) : ("vscode" as const) } : {}),
    recentPrompts: [],
    recentFiles: [],
  };
}

/** interactive 먼저, 그 안에서는 시작 순서. 갱신해도 순서가 흔들리지 않게 고정 기준만 쓴다. */
function compareSessions(a: Session, b: Session): number {
  if (a.kind !== b.kind) return a.kind === "interactive" ? -1 : 1;
  return a.startedAt - b.startedAt || a.key.localeCompare(b.key);
}

export async function buildSnapshot(deps: RegistryDeps): Promise<SessionSnapshot> {
  const [agentsRes, panesRes] = await Promise.all([deps.listAgents(), deps.listPanes()]);
  const warnings = [...agentsRes.warnings];
  if (agentsRes.error) warnings.push(agentsRes.error);
  if (panesRes.error) warnings.push(`tmux: ${panesRes.error}`);
  const sessions = await Promise.all(agentsRes.agents.map((a) => toSession(a, panesRes.panes, deps)));
  sessions.sort(compareSessions);
  return { sessions, takenAt: Date.now(), tmuxRunning: panesRes.serverRunning, warnings, ...(agentsRes.source ? { source: agentsRes.source } : {}) };
}

/** 변경 비교용 지문. 시각(takenAt)처럼 매번 바뀌는 값은 뺀다. */
function fingerprint(s: SessionSnapshot): string {
  return JSON.stringify([s.sessions, s.tmuxRunning, s.warnings]);
}

export type RegistryOptions = {
  /** 정합성 갱신 주기. */
  intervalMs?: number;
  /** 레지스트리 디렉터리 변경 뒤 갱신까지 기다리는 시간. */
  debounceMs?: number;
  watchDir?: string | null;
};

/**
 * 세션 목록을 유지한다. 내부 레지스트리 디렉터리 변경을 힌트로 즉시 갱신하고,
 * 주기적으로 `claude agents --json`을 다시 읽어 맞춘다. 바뀌었을 때만 "change"를 낸다.
 */
export class SessionRegistry extends EventEmitter<{ change: [SessionSnapshot]; error: [Error] }> {
  readonly #deps: RegistryDeps;
  readonly #opts: Required<RegistryOptions>;
  #snapshot: SessionSnapshot | null = null;
  #inflight: Promise<SessionSnapshot> | null = null;
  #again = false;
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #watcher: FSWatcher | null = null;

  constructor(deps: RegistryDeps = defaultDeps(), opts: RegistryOptions = {}) {
    super();
    this.#deps = deps;
    this.#opts = {
      intervalMs: opts.intervalMs ?? 15_000,
      debounceMs: opts.debounceMs ?? 300,
      watchDir: opts.watchDir === undefined ? sessionsDir() : opts.watchDir,
    };
  }

  get snapshot(): SessionSnapshot | null {
    return this.#snapshot;
  }

  /** 동시에 여러 번 불려도 한 번만 실행하고, 실행 중에 다시 요청되면 끝난 뒤 한 번 더 돈다. */
  refresh(): Promise<SessionSnapshot> {
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#inflight = (async () => {
      try {
        let snap: SessionSnapshot;
        do {
          this.#again = false;
          snap = await buildSnapshot(this.#deps);
          const changed = !this.#snapshot || fingerprint(snap) !== fingerprint(this.#snapshot);
          this.#snapshot = snap;
          if (changed) this.emit("change", snap);
        } while (this.#again);
        return snap;
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }

  start(): void {
    const tick = () => void this.refresh().catch((e: unknown) => this.emit("error", toError(e)));
    tick();
    this.#timer = setInterval(tick, this.#opts.intervalMs);
    this.#timer.unref();
    if (this.#opts.watchDir) {
      try {
        this.#watcher = watch(this.#opts.watchDir, () => {
          if (this.#debounce) clearTimeout(this.#debounce);
          this.#debounce = setTimeout(tick, this.#opts.debounceMs);
        });
        this.#watcher.on("error", (e) => this.emit("error", toError(e)));
      } catch (e) {
        // 디렉터리가 없어도 주기 갱신만으로 동작한다.
        this.emit("error", toError(e));
      }
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#watcher?.close();
    this.#timer = this.#debounce = null;
    this.#watcher = null;
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
