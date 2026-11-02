import { describe, expect, it } from "vitest";
import { lsofField } from "../context.ts";
import { ancestry, parsePsLine, psReader } from "./proc.ts";

// macOS `ps -A -o pid=,ppid=,lstart=,comm=` (LC_ALL=C) 실제 형식
const PS = [
  "    1     0 Mon Nov  2 09:00:01 2026     /sbin/launchd",
  "  512     1 Mon Nov  2 09:00:05 2026     /usr/local/bin/tmux",
  "  900   512 Mon Nov  2 10:12:44 2026     -zsh",
  "  901   900 Mon Nov  2 10:12:50 2026     /Users/me/.local/bin/claude --resume",
  "bad line",
].join("\n");

describe("macOS 프로세스·포트", () => {
  it("ps 한 줄: pid, ppid, 시작 시각(재사용 판별), 명령", () => {
    expect(parsePsLine(PS.split("\n")[3]!)).toEqual({
      pid: 901,
      ppid: 900,
      startTime: "Mon Nov 2 10:12:50 2026",
      startedMs: new Date(2026, 10, 2, 10, 12, 50).getTime(),
      comm: "/Users/me/.local/bin/claude --resume",
    });
    expect(parsePsLine("bad line")).toBeNull();
  });

  it("ps 표 한 번으로 계보(claude → zsh → tmux)를 따라가고, 잠깐은 다시 부르지 않는다", async () => {
    let calls = 0;
    let t = 0;
    const read = psReader(async () => (calls++, PS), 2000, () => t);
    const chain = await ancestry(901, read);
    expect(chain.map((p) => p.pid)).toEqual([901, 900, 512]);
    expect(calls).toBe(1);
    t = 5000;
    await read(901);
    expect(calls).toBe(2);
    expect(await read(4242)).toBeNull();
  });

  it("lsof -F 출력에서 pid와 작업 폴더", () => {
    expect(lsofField("p4321\nf12\n", "p")).toBe("4321");
    expect(lsofField("p4321\nfcwd\nn/Users/me/shop/web\n", "n")).toBe("/Users/me/shop/web");
    expect(lsofField("", "p")).toBeNull();
  });
});
