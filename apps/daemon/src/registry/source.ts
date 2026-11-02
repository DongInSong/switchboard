import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsResult, RawAgent } from "./agents.ts";
import type { ProcStat } from "./proc.ts";

/**
 * 세션 목록의 출처.
 * `claude agents --json`(공식)은 한 번에 ~144MB·0.2초짜리 프로세스라 15초마다 + 상태가 바뀔 때마다 부르기엔 무겁다.
 * 그래서 평소에는 Claude Code가 세션마다 남기는 `~/.claude/sessions/<pid>.json`을 직접 읽고(파일 150개 1.6ms),
 * 공식 명령은 시작할 때와 5분마다만 불러 ① 백그라운드 세션(파일에 없음)을 얻고 ② 파일 형식이 그대로인지 맞춰 본다.
 * 어긋나면(Claude Code 업데이트로 형식이 바뀌었을 수 있음) 다음 확인 때까지 공식 명령으로만 간다.
 */

export type ListedAgents = AgentsResult & { source: "registry" | "agents" };

/**
 * 레지스트리 파일 → 살아 있는 대화형 세션. 파일은 프로세스가 죽어도 남고 pid는 재사용되므로 시작 시각까지 맞춘다.
 * - Linux: 파일의 procStart = /proc의 starttime(정확히 같은 형식)
 * - 그 밖(macOS): 프로세스 시작 시각이 세션 시작(startedAt)보다 뒤면 다른 프로세스(재사용된 pid)
 */
export async function listAgentsFromRegistry(
  dir: string,
  readStat: (pid: number) => Promise<ProcStat | null>,
  exactStart: boolean,
): Promise<AgentsResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    return { agents: [], warnings: [], error: `registry dir: ${e instanceof Error ? e.message : String(e)}` };
  }
  const agents: RawAgent[] = [];
  const warnings: string[] = [];
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(await readFile(join(dir, n), "utf8")) as Record<string, unknown>;
        } catch {
          return; // 쓰는 중이거나 깨진 파일: 다음 갱신 때
        }
        if (d.kind !== "interactive" || typeof d.pid !== "number" || typeof d.cwd !== "string") return;
        const stat = await readStat(d.pid);
        if (!stat) return;
        const startedAt = typeof d.startedAt === "number" ? d.startedAt : 0;
        if (exactStart) {
          if (typeof d.procStart === "string" && d.procStart !== stat.startTime) return;
        } else if (stat.startedMs !== undefined && startedAt > 0 && stat.startedMs > startedAt + 60_000) {
          return;
        }
        agents.push({
          pid: d.pid,
          cwd: d.cwd,
          kind: "interactive",
          startedAt,
          ...(typeof d.sessionId === "string" ? { sessionId: d.sessionId } : {}),
          ...(typeof d.name === "string" ? { name: d.name } : {}),
          ...(typeof d.status === "string" ? { status: d.status } : {}),
          ...(typeof d.waitingFor === "string" ? { waitingFor: d.waitingFor } : {}),
        });
      }),
  );
  agents.sort((a, b) => a.startedAt - b.startedAt || (a.pid ?? 0) - (b.pid ?? 0));
  return { agents, warnings };
}

/** 공식 목록의 대화형 세션이 파일에도 다 있으면(같은 pid·세션) 파일을 믿는다. 파일에만 있는 새 세션은 괜찮다. */
export function filesAgree(files: AgentsResult, official: AgentsResult): boolean {
  const byPid = new Map(files.agents.map((a) => [a.pid, a]));
  return official.agents
    .filter((a) => a.kind === "interactive" && a.pid !== undefined)
    .every((a) => {
      const f = byPid.get(a.pid);
      return f !== undefined && (!a.sessionId || !f.sessionId || a.sessionId === f.sessionId);
    });
}

export class AgentSource {
  readonly #official: () => Promise<AgentsResult>;
  readonly #files: () => Promise<AgentsResult>;
  readonly #everyMs: number;
  readonly #now: () => number;
  #cached: AgentsResult | null = null;
  #at = Number.NEGATIVE_INFINITY;
  #trustFiles = true;

  constructor(o: { official: () => Promise<AgentsResult>; files: () => Promise<AgentsResult>; officialEveryMs?: number; now?: () => number }) {
    this.#official = o.official;
    this.#files = o.files;
    this.#everyMs = o.officialEveryMs ?? 5 * 60_000;
    this.#now = o.now ?? Date.now;
  }

  async #refreshOfficial(): Promise<AgentsResult> {
    const off = await this.#official();
    if (!off.error) {
      this.#cached = off;
      this.#at = this.#now();
    }
    return off;
  }

  async list(): Promise<ListedAgents> {
    const due = this.#now() - this.#at >= this.#everyMs;
    const off = due ? await this.#refreshOfficial() : null;
    const files = await this.#files();
    if (due && off && !off.error && !files.error) this.#trustFiles = filesAgree(files, off);
    if (files.error || !this.#trustFiles) {
      // 파일을 못 믿으면 예전처럼 공식 명령으로(이번에 이미 불렀으면 그 결과)
      const res = off ?? (await this.#refreshOfficial());
      const warnings = [...res.warnings, ...(files.error ? [files.error] : !this.#trustFiles ? ["registry files disagree with claude agents --json; using claude agents"] : [])];
      return { ...res, warnings, source: "agents" };
    }
    const background = (this.#cached?.agents ?? []).filter((a) => a.kind !== "interactive");
    return { agents: [...files.agents, ...background], warnings: files.warnings, source: "registry" };
  }
}
