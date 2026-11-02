import type { Session } from "@switchboard/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { setLang } from "../i18n.ts";
import { dispatchLabel, elapsed, orderedSessions, primaryLabel, relativeTime, sourceShort, statusOf } from "./labels.ts";

const s = (over: Partial<Session>): Session => ({ key: "k", name: "n", kind: "interactive", cwd: "/a", startedAt: 0, dispatchable: true, recentPrompts: [], recentFiles: [], ...over });

beforeAll(() => setLang("ko"));

describe("labels", () => {
  it("상태 문구와 기본 버튼", () => {
    expect(statusOf(s({ status: "idle" }))).toEqual({ label: "유휴", tone: "idle" });
    expect(statusOf(s({ status: "waiting" })).label).toBe("대기");
    expect(statusOf(s({ dispatchable: false, status: "idle" })).label).toBe("보기 전용");
    expect(primaryLabel(s({ status: "idle" }))).toBe("보내기");
    expect(primaryLabel(s({ status: "busy" }))).toBe("예약");
    expect(primaryLabel(undefined)).toBe("보내기");
  });

  it("보낼 수 있는 세션을 먼저, 원래 순서 유지", () => {
    const list = orderedSessions({ takenAt: 0, tmuxRunning: true, warnings: [], sessions: [s({ key: "a", dispatchable: false }), s({ key: "b" }), s({ key: "c" })] });
    expect(list.map((x) => x.key)).toEqual(["b", "c", "a"]);
  });

  it("전달 상태 문구: 기다릴 이유가 있을 때만 예약", () => {
    const d = { id: 1, requestId: 1, sessionKey: "k", sessionName: "n", paneId: null, mode: "wait-idle" as const, marker: "m", createdAt: 0, deliveredAt: null, finishedAt: null, error: null, summary: null };
    expect(dispatchLabel({ ...d, state: "queued", waitReason: null }).label).toBe("전달");
    expect(dispatchLabel({ ...d, state: "queued", waitReason: "busy" }).label).toBe("예약");
    expect(dispatchLabel({ ...d, state: "working", waitReason: null }).label).toBe("작업 중");
    expect(dispatchLabel(null).label).toBe("저장");
  });

  it("짧은 소스 위치와 시간", () => {
    expect(sourceShort({ file: "http://127.0.0.1:5199/src/AvatarMenu.tsx?t=1", line: 10, lineApprox: true, framework: "react", via: "x" })).toEqual({
      short: "AvatarMenu.tsx:~10",
      full: "/src/AvatarMenu.tsx:~10",
    });
    expect(relativeTime(0, 30_000)).toBe("now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5m");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3h");
    expect(elapsed(42_000)).toBe("0:42");
    expect(elapsed(3_723_000)).toBe("1:02:03");
  });
});
