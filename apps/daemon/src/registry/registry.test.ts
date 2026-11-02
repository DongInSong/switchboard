import { Session, SessionSnapshot } from "@switchboard/protocol";
import { describe, expect, it } from "vitest";
import type { RawAgent } from "./agents.ts";
import type { ProcStat } from "./proc.ts";
import { SessionRegistry, buildSnapshot, type RegistryDeps } from "./registry.ts";
import type { RegistryFileInfo } from "./registryFile.ts";
import type { Pane } from "./tmux.ts";

function pane(session: string, paneId: string, panePid: number, extra: Partial<Pane> = {}): Pane {
  return { session, windowId: "@1", windowIndex: 0, paneId, panePid, command: "claude", inMode: false, path: "/", ...extra };
}

type World = {
  agents: RawAgent[];
  panes: Pane[];
  procs: ProcStat[];
  files?: Record<number, RegistryFileInfo>;
  tmuxRunning?: boolean;
  agentsError?: string;
};

function deps(world: World, calls?: { agents: number }): RegistryDeps {
  const byPid = new Map(world.procs.map((p) => [p.pid, p]));
  return {
    listAgents: async () => {
      if (calls) calls.agents++;
      return { agents: world.agents, warnings: [], ...(world.agentsError ? { error: world.agentsError } : {}) };
    },
    listPanes: async () => ({ panes: world.panes, serverRunning: world.tmuxRunning ?? true }),
    readStat: async (pid) => byPid.get(pid) ?? null,
    readRegistryFile: async (pid) => world.files?.[pid] ?? null,
    gitInfo: async (cwd) => (cwd.startsWith("/repo") ? { root: "/repo", branch: "dev" } : null),
  };
}

const proc = (pid: number, ppid: number, comm = "x", startTime = `st${pid}`): ProcStat => ({ pid, ppid, comm, startTime });
const tmuxServer = proc(1341, 1, "tmux: server");

describe("buildSnapshot", () => {
  it("셸을 거친 pane과 claude를 직접 띄운 pane 둘 다 pid 계보로 찾는다", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [
          { pid: 148051, cwd: "/repo", kind: "interactive", startedAt: 1, sessionId: "s-shell", name: "via-shell", status: "busy" },
          { pid: 203971, cwd: "/repo/sub", kind: "interactive", startedAt: 2, sessionId: "s-direct", name: "direct", status: "idle" },
        ],
        panes: [pane("trio", "%4", 1377), pane("sb", "%8", 203971)],
        procs: [proc(148051, 1377, "claude", "491338"), proc(1377, 1341, "bash"), proc(203971, 1341, "claude"), tmuxServer],
      }),
    );
    const [shell, direct] = snap.sessions;
    expect(shell).toMatchObject({ key: "s-shell", procStart: "491338", dispatchable: true, git: { root: "/repo", branch: "dev" } });
    expect(shell?.tmux).toMatchObject({ session: "trio", paneId: "%4", via: "ancestry" });
    expect(direct?.tmux).toMatchObject({ session: "sb", paneId: "%8", via: "ancestry" });
  });

  it("계보로 못 찾으면 레지스트리 파일을 쓰되, procStart가 다르면 믿지 않는다", async () => {
    const world: World = {
      agents: [
        { pid: 500, cwd: "/a", kind: "interactive", startedAt: 1, name: "file-ok", status: "idle" },
        { pid: 600, cwd: "/b", kind: "interactive", startedAt: 2, name: "file-stale", status: "idle" },
      ],
      panes: [pane("trio", "%9", 9999), pane("trio", "%10", 9998)],
      procs: [proc(500, 400, "claude", "777"), proc(400, 1), proc(600, 400, "claude", "888")],
      files: {
        500: { procStart: "777", tmux: { session: "trio", windowId: "@1", paneId: "%9" } },
        600: { procStart: "111", tmux: { session: "trio", windowId: "@1", paneId: "%10" } },
      },
    };
    const [ok, stale] = (await buildSnapshot(deps(world))).sessions;
    expect(ok?.tmux).toMatchObject({ paneId: "%9", via: "registry-file" });
    expect(ok?.dispatchable).toBe(true);
    expect(stale?.tmux).toBeUndefined();
    expect(stale).toMatchObject({ dispatchable: false, notDispatchableReason: "no-tmux", key: "pid:600" });
  });

  it("VS Code 세션은 tmux 밖이어도 VS Code 방식으로 보낼 수 있고, 터미널 세션은 tmux 밖이면 보기 전용", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [
          { pid: 710, cwd: "/repo", kind: "interactive", startedAt: 1, sessionId: "s-vscode", name: "vs", status: "idle" },
          { pid: 711, cwd: "/repo", kind: "interactive", startedAt: 2, sessionId: "s-term", name: "term", status: "idle" },
          { pid: 712, cwd: "/repo", kind: "interactive", startedAt: 3, sessionId: "s-reused", name: "reused", status: "idle" },
          { pid: 713, cwd: "/repo", kind: "interactive", startedAt: 4, sessionId: "s-tmux", name: "tmuxed", status: "idle" },
        ],
        panes: [pane("trio", "%3", 713)],
        procs: [proc(710, 1, "claude", "a"), proc(711, 1, "claude", "b"), proc(712, 1, "claude", "c"), proc(713, 1341, "claude", "d"), tmuxServer],
        files: { 710: { procStart: "a", entrypoint: "claude-vscode" }, 711: { procStart: "b", entrypoint: "cli" }, 712: { procStart: "old", entrypoint: "claude-vscode" }, 713: { entrypoint: "cli" } },
      }),
    );
    const by = Object.fromEntries(snap.sessions.map((x) => [x.name, x]));
    expect(by.vs).toMatchObject({ surface: "vscode", dispatchable: true, delivery: "vscode" });
    expect(by.term).toMatchObject({ surface: "terminal", dispatchable: false, notDispatchableReason: "no-tmux" });
    expect(by.term?.delivery).toBeUndefined();
    // pid가 재사용된 레지스트리 파일은 믿지 않는다
    expect(by.reused).toMatchObject({ surface: "terminal", dispatchable: false });
    expect(by.tmuxed).toMatchObject({ surface: "terminal", delivery: "tmux" });
  });

  it("보낼 수 없는 이유를 구분한다: 백그라운드, 죽은 pid, tmux 밖", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [
          { id: "5c3c78bf", cwd: "/w", kind: "background", startedAt: 1, name: "bg", state: "blocked" },
          { pid: 700, cwd: "/w", kind: "interactive", startedAt: 2, name: "dead", status: "idle" },
          { pid: 800, cwd: "/w", kind: "interactive", startedAt: 3, name: "plain-terminal", status: "idle" },
        ],
        panes: [],
        procs: [proc(800, 1)],
      }),
    );
    const byName = Object.fromEntries(snap.sessions.map((s) => [s.name, s]));
    expect(byName.bg).toMatchObject({ kind: "background", backgroundState: "blocked", notDispatchableReason: "background", key: "bg:5c3c78bf" });
    expect(byName.dead).toMatchObject({ notDispatchableReason: "not-alive" });
    expect(byName["plain-terminal"]).toMatchObject({ notDispatchableReason: "no-tmux" });
  });

  it("interactive 먼저, 그 안에서는 시작 순서로 고정 정렬한다", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [
          { id: "b1", cwd: "/", kind: "background", startedAt: 1 },
          { pid: 2, cwd: "/", kind: "interactive", startedAt: 30, name: "late" },
          { pid: 3, cwd: "/", kind: "interactive", startedAt: 10, name: "early" },
        ],
        panes: [],
        procs: [],
      }),
    );
    expect(snap.sessions.map((s) => s.name)).toEqual(["early", "late", "b1"]);
  });

  it("모르는 status 값은 버리고, 명령 오류는 경고로 올린다", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [{ pid: 9, cwd: "/", kind: "interactive", startedAt: 1, status: "thinking-hard" }],
        panes: [],
        procs: [],
        tmuxRunning: false,
        agentsError: "claude agents --json 실패: timeout",
      }),
    );
    expect(snap.sessions[0]?.status).toBeUndefined();
    expect(snap.tmuxRunning).toBe(false);
    expect(snap.warnings).toContain("claude agents --json 실패: timeout");
  });

  it("결과는 protocol 스키마를 만족한다", async () => {
    const snap = await buildSnapshot(
      deps({
        agents: [
          { pid: 148051, cwd: "/repo", kind: "interactive", startedAt: 1, sessionId: "s1", name: "a", status: "waiting", waitingFor: "permission prompt" },
          { id: "bg1", cwd: "/w", kind: "background", startedAt: 2, state: "done" },
        ],
        panes: [pane("trio", "%4", 1377)],
        procs: [proc(148051, 1377), proc(1377, 1341), tmuxServer],
      }),
    );
    expect(() => SessionSnapshot.parse(snap)).not.toThrow();
    for (const s of snap.sessions) expect(Session.safeParse(s).success).toBe(true);
  });
});

describe("SessionRegistry", () => {
  const world: World = {
    agents: [{ pid: 10, cwd: "/", kind: "interactive", startedAt: 1, name: "a", status: "idle" }],
    panes: [pane("t", "%1", 10)],
    procs: [proc(10, 1)],
  };

  it("내용이 같으면 change를 다시 내지 않고, 바뀌면 낸다", async () => {
    const reg = new SessionRegistry(deps(world), { watchDir: null });
    const seen: string[] = [];
    reg.on("change", (s) => seen.push(s.sessions.map((x) => x.status).join(",")));
    await reg.refresh();
    await reg.refresh();
    expect(seen).toEqual(["idle"]);
    world.agents = [{ ...world.agents[0]!, status: "busy" }];
    await reg.refresh();
    expect(seen).toEqual(["idle", "busy"]);
    expect(reg.snapshot?.sessions[0]?.status).toBe("busy");
  });

  it("동시에 여러 번 불려도 겹쳐 실행하지 않는다", async () => {
    const calls = { agents: 0 };
    const reg = new SessionRegistry(deps(world, calls), { watchDir: null });
    await Promise.all([reg.refresh(), reg.refresh(), reg.refresh()]);
    // 첫 실행 + 실행 중 들어온 요청을 모아 한 번 더 = 2회
    expect(calls.agents).toBe(2);
  });
});
