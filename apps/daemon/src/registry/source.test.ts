import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsResult } from "./agents.ts";
import type { ProcStat } from "./proc.ts";
import { AgentSource, filesAgree, listAgentsFromRegistry } from "./source.ts";

const stats: Record<number, ProcStat> = {
  100: { pid: 100, ppid: 1, comm: "claude", startTime: "5000", startedMs: Date.parse("2026-11-02T10:00:00Z") },
  200: { pid: 200, ppid: 1, comm: "bash", startTime: "9999", startedMs: Date.parse("2026-11-02T12:00:00Z") },
};
const readStat = async (pid: number) => stats[pid] ?? null;

function dir(files: Record<string, unknown>) {
  const d = mkdtempSync(join(tmpdir(), "sb-reg-"));
  for (const [name, v] of Object.entries(files)) writeFileSync(join(d, name), typeof v === "string" ? v : JSON.stringify(v));
  return d;
}

const live = { pid: 100, kind: "interactive", cwd: "/repo", sessionId: "s1", name: "app-1", status: "busy", startedAt: Date.parse("2026-11-02T10:00:03Z"), procStart: "5000" };

describe("레지스트리 파일에서 세션 읽기", () => {
  it("살아 있는 대화형 세션만: 죽은 pid·재사용된 pid·백그라운드·깨진 파일은 뺀다", async () => {
    const d = dir({
      "100.json": live,
      "300.json": { ...live, pid: 300, sessionId: "dead" },
      "200.json": { ...live, pid: 200, sessionId: "old", procStart: "1234", startedAt: Date.parse("2026-10-01T00:00:00Z") },
      "101.json": { ...live, pid: 101, kind: "bg" },
      "102.json": "{ broken",
      "100.abc.key": "x",
    });
    const r = await listAgentsFromRegistry(d, readStat, true);
    expect(r.agents).toEqual([{ pid: 100, cwd: "/repo", kind: "interactive", startedAt: live.startedAt, sessionId: "s1", name: "app-1", status: "busy" }]);
  });

  it("macOS(시작 시각 형식이 다름): 프로세스가 세션보다 늦게 떴으면 재사용된 pid로 보고 뺀다", async () => {
    const d = dir({ "100.json": { ...live, procStart: "mac-format" }, "200.json": { ...live, pid: 200, sessionId: "old", startedAt: Date.parse("2026-11-01T00:00:00Z") } });
    const r = await listAgentsFromRegistry(d, readStat, false);
    expect(r.agents.map((a) => a.sessionId)).toEqual(["s1"]);
  });
});

describe("AgentSource", () => {
  const off = (agents: AgentsResult["agents"]): AgentsResult => ({ agents, warnings: [] });
  const bg = { kind: "background", id: "b1", cwd: "/w", startedAt: 1, name: "bg" };
  const inter = { kind: "interactive", pid: 100, sessionId: "s1", cwd: "/repo", startedAt: 2, name: "app-1", status: "idle" };

  it("공식 명령은 처음과 5분마다만, 그 사이엔 파일 + 캐시한 백그라운드 세션", async () => {
    let calls = 0;
    let t = 0;
    const files = off([{ ...inter, status: "busy" }]);
    const s = new AgentSource({ official: async () => (calls++, off([inter, bg])), files: async () => files, now: () => t });
    const a = await s.list();
    expect(a.source).toBe("registry");
    expect(a.agents.map((x) => x.name)).toEqual(["app-1", "bg"]);
    expect(a.agents[0]!.status).toBe("busy"); // 상태는 파일(더 최신) 것
    t = 60_000;
    await s.list();
    t = 4 * 60_000;
    await s.list();
    expect(calls).toBe(1);
    t = 5 * 60_000 + 1;
    await s.list();
    expect(calls).toBe(2);
  });

  it("파일과 공식 목록이 어긋나면(형식 변경 등) 공식 명령으로 돌아가고, 다음 확인에서 맞으면 다시 파일로", async () => {
    let t = 0;
    let files = off([]);
    const s = new AgentSource({ official: async () => off([inter]), files: async () => files, now: () => t });
    const a = await s.list();
    expect(a.source).toBe("agents");
    expect(a.agents.map((x) => x.pid)).toEqual([100]);
    expect(a.warnings[0]).toMatch(/disagree/);
    files = off([inter]);
    t = 5 * 60_000;
    expect((await s.list()).source).toBe("registry");
  });

  it("공식 명령이 실패해도(claude 없음 등) 파일로 계속 간다", async () => {
    const s = new AgentSource({ official: async () => ({ agents: [], warnings: [], error: "spawn claude ENOENT" }), files: async () => off([inter]) });
    const a = await s.list();
    expect(a.source).toBe("registry");
    expect(a.agents).toHaveLength(1);
    expect(filesAgree(off([inter]), off([{ ...inter, sessionId: "other" }]))).toBe(false);
  });
});
