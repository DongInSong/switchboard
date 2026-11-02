import type { Session, SessionSnapshot } from "@switchboard/protocol";
import { describe, expect, it } from "vitest";
import { displayWidth, plain, renderSessionTable, statusText, tildify } from "./format.ts";

function session(over: Partial<Session>): Session {
  return {
    key: over.name ?? "k",
    name: "s",
    kind: "interactive",
    cwd: "/home/u/app",
    startedAt: 0,
    dispatchable: true,
    recentPrompts: [],
    recentFiles: [],
    ...over,
  };
}

describe("format helpers", () => {
  it("한글은 2칸으로 센다", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("시간 필터")).toBe(9);
  });

  it("홈 디렉터리를 ~로 줄인다", () => {
    expect(tildify("/home/u/app", "/home/u")).toBe("~/app");
    expect(tildify("/home/u", "/home/u")).toBe("~");
    expect(tildify("/home/user2/x", "/home/u")).toBe("/home/user2/x");
  });

  it("대기 중이면 무엇을 기다리는지 함께 표시한다", () => {
    expect(statusText(session({ status: "waiting", waitingFor: "permission prompt" }))).toBe("waiting (permission prompt)");
    expect(statusText(session({ kind: "background", backgroundState: "blocked" }))).toBe("blocked");
  });
});

describe("renderSessionTable", () => {
  const snap: SessionSnapshot = {
    takenAt: 0,
    tmuxRunning: true,
    warnings: ["claude agents --json[3] 건너뜀"],
    sessions: [
      session({
        name: "app-71",
        status: "idle",
        pid: 12771,
        git: { root: "/home/u/app", branch: "dev" },
        tmux: { session: "trio", windowId: "@1", windowIndex: 0, paneId: "%1", paneCommand: "claude", inMode: false, via: "ancestry" },
      }),
      session({ name: "시간 필터 작업", kind: "background", backgroundState: "blocked", dispatchable: false, notDispatchableReason: "background" }),
    ],
  };

  it("열을 표시 폭 기준으로 맞추고 요약·경고를 붙인다", () => {
    const out = renderSessionTable(snap, plain).split("\n");
    expect(out[0]).toMatch(/^NAME\s+STATUS\s+PANE\s+PID\s+CWD\s+BRANCH$/);
    expect(out[1]).toContain("trio:%1");
    // STATUS 열 시작 위치가 한글 이름 줄과 같아야 한다.
    const col = (line: string, word: string) => displayWidth(line.slice(0, line.indexOf(word)));
    expect(col(out[1]!, "idle")).toBe(col(out[2]!, "blocked"));
    expect(out).toContain("2 sessions · 1 sendable");
    expect(out.at(-1)).toBe("! claude agents --json[3] 건너뜀");
  });
});
