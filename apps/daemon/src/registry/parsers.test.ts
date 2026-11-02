import { describe, expect, it } from "vitest";
import { parseAgents } from "./agents.ts";
import { ancestry, parseStat, type ProcStat } from "./proc.ts";
import { parseRegistryFile, parseTmuxField } from "./registryFile.ts";
import { PANE_FORMAT, parsePanes } from "./tmux.ts";

/** /proc/<pid>/stat 형식: pid (comm) state ppid ... starttime(22번째) ... */
function statLine(pid: number, comm: string, ppid: number, startTime: string): string {
  const fields = ["S", String(ppid)];
  // 5~21번째 필드 채우기 (17개)
  for (let i = 5; i <= 21; i++) fields.push("0");
  fields.push(startTime, "123456", "789");
  return `${pid} (${comm}) ${fields.join(" ")}`;
}

describe("parseStat", () => {
  it("pid, comm, ppid, starttime을 읽는다", () => {
    expect(parseStat(statLine(148051, "claude", 1377, "491338"))).toEqual({
      pid: 148051,
      comm: "claude",
      ppid: 1377,
      startTime: "491338",
    });
  });

  it("comm에 공백과 괄호가 있어도 마지막 ')' 기준으로 자른다", () => {
    expect(parseStat(statLine(1341, "tmux: server", 1, "42"))?.comm).toBe("tmux: server");
    expect(parseStat(statLine(7, "a) (b", 1, "9"))).toMatchObject({ comm: "a) (b", ppid: 1, startTime: "9" });
  });

  it("형식이 틀리면 null", () => {
    expect(parseStat("")).toBeNull();
    expect(parseStat("12 (x) S")).toBeNull();
  });
});

describe("ancestry", () => {
  const table: Record<number, ProcStat> = {
    300: { pid: 300, comm: "claude", ppid: 200, startTime: "3" },
    200: { pid: 200, comm: "bash", ppid: 100, startTime: "2" },
    100: { pid: 100, comm: "tmux: server", ppid: 1, startTime: "1" },
  };
  const read = async (pid: number) => table[pid] ?? null;

  it("자기 자신부터 init 직전까지", async () => {
    expect((await ancestry(300, read)).map((p) => p.pid)).toEqual([300, 200, 100]);
  });

  it("없는 pid는 빈 배열", async () => {
    expect(await ancestry(999, read)).toEqual([]);
  });

  it("순환이 있어도 깊이 제한에서 멈춘다", async () => {
    const loop = async (pid: number): Promise<ProcStat> => ({ pid, comm: "x", ppid: pid === 10 ? 11 : 10, startTime: "0" });
    expect(await ancestry(10, loop, 5)).toHaveLength(5);
  });
});

describe("parsePanes", () => {
  it("탭으로 구분된 list-panes 출력을 읽는다", () => {
    const out = [
      ["trio", "@1", "0", "%4", "1377", "claude", "0", "/home/u/project"].join("\t"),
      ["quad", "@0", "2", "%6", "1409", "claude", "1", "/home/u/with\ttab"].join("\t"),
      "",
    ].join("\n");
    expect(parsePanes(out)).toEqual([
      { session: "trio", windowId: "@1", windowIndex: 0, paneId: "%4", panePid: 1377, command: "claude", inMode: false, path: "/home/u/project" },
      { session: "quad", windowId: "@0", windowIndex: 2, paneId: "%6", panePid: 1409, command: "claude", inMode: true, path: "/home/u/with\ttab" },
    ]);
  });

  it("필드가 모자라거나 pid가 숫자가 아니면 건너뛴다", () => {
    expect(parsePanes("trio\t@1\t0\n")).toEqual([]);
    expect(parsePanes(["a", "@1", "0", "%1", "x", "bash", "0", "/"].join("\t"))).toEqual([]);
  });

  it("포맷 문자열은 tmux가 그대로 출력하는 탭을 구분자로 쓴다", () => {
    // 회귀: \x1f는 tmux가 "\037" 문자열로 바꿔 출력해서 파싱이 전부 실패했다.
    expect(PANE_FORMAT).toContain("\t");
    expect(PANE_FORMAT).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
  });
});

describe("parseAgents", () => {
  const fixture = JSON.stringify([
    { id: "5c3c78bf", cwd: "/home/u/ws", kind: "background", startedAt: 1, sessionId: "5c3c78bf-aaaa", name: "doc work", state: "blocked" },
    { pid: 12771, cwd: "/home/u/app", kind: "interactive", startedAt: 2, sessionId: "2ed6-bbbb", name: "app-71", status: "idle", futureField: true },
    { pid: 41578, cwd: "/home/u/app", kind: "interactive", startedAt: 3, status: "waiting", waitingFor: "permission prompt" },
    { cwd: "/home/u/broken" },
  ]);

  it("유효한 항목만 받고, 깨진 항목은 경고로 남긴다", () => {
    const res = parseAgents(fixture);
    expect(res.error).toBeUndefined();
    expect(res.agents.map((a) => a.kind)).toEqual(["background", "interactive", "interactive"]);
    expect(res.agents[2]).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("[3]");
  });

  it("JSON이 아니거나 배열이 아니면 error", () => {
    expect(parseAgents("not json").error).toBeDefined();
    expect(parseAgents("{}").error).toBeDefined();
  });
});

describe("registry file", () => {
  it("tmux 필드를 세션·창·pane으로 나눈다", () => {
    expect(parseTmuxField("trio:@1.%4")).toEqual({ session: "trio", windowId: "@1", paneId: "%4" });
    expect(parseTmuxField("my:sess:@12.%103")).toEqual({ session: "my:sess", windowId: "@12", paneId: "%103" });
    expect(parseTmuxField("trio")).toBeUndefined();
    expect(parseTmuxField("trio:1.4")).toBeUndefined();
  });

  it("필요한 필드만 읽고 나머지는 무시한다", () => {
    expect(parseRegistryFile(JSON.stringify({ pid: 1, procStart: "491338", tmux: "trio:@1.%4", status: "busy" }))).toEqual({
      procStart: "491338",
      tmux: { session: "trio", windowId: "@1", paneId: "%4" },
    });
    expect(parseRegistryFile("{}")).toEqual({});
    expect(parseRegistryFile("nope")).toBeNull();
  });
});
