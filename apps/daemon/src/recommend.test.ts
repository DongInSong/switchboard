import type { Session } from "@switchboard/protocol";
import { describe, expect, it } from "vitest";
import { parseSsListeners, localPort, isUnder } from "./context.ts";
import { recommend, tokenize, topicScore } from "./recommend.ts";

const NOW = 1_800_000_000_000;

function s(over: Partial<Session> & { key: string }): Session {
  return { name: over.key, kind: "interactive", cwd: "/", startedAt: 0, status: "idle", dispatchable: true, recentPrompts: [], recentFiles: [], ...over };
}

describe("recommend", () => {
  const base = {
    sourceFile: "/home/u/project/app/src/Card.tsx",
    devServerRoot: "/home/u/project/app",
    queryText: "",
    previousSessionKey: null,
    now: NOW,
  };

  it("소스 파일과 dev 서버가 속한 프로젝트 세션을 높은 신뢰도로 1위", () => {
    const recs = recommend({
      ...base,
      sessions: [s({ key: "other", cwd: "/home/u/project/other" }), s({ key: "app", cwd: "/home/u/project/app", git: { root: "/home/u/project/app" } })],
    });
    expect(recs[0]).toMatchObject({ sessionKey: "app", confidence: "high", reasons: ["source-match", "dev-server"] });
    expect(recs.map((r) => r.sessionKey)).not.toContain("other");
  });

  it("작업 공간 루트에서 띄운 세션보다 프로젝트 폴더 세션이 앞선다", () => {
    const recs = recommend({
      ...base,
      sessions: [s({ key: "root", cwd: "/home/u/project" }), s({ key: "app", cwd: "/home/u/project/app" })],
    });
    expect(recs.map((r) => r.sessionKey)).toEqual(["app", "root"]);
    expect(recs[0]!.score).toBeGreaterThan(recs[1]!.score);
  });

  it("같은 폴더 세션 둘: 최근에 그 파일을 고친 세션이 앞선다", () => {
    const recs = recommend({
      ...base,
      sessions: [
        s({ key: "a", cwd: "/home/u/project/app" }),
        s({ key: "b", cwd: "/home/u/project/app", recentFiles: [{ path: "/home/u/project/app/src/Card.tsx", op: "edit", at: NOW - 5 * 60_000 }] }),
      ],
    });
    expect(recs[0]).toMatchObject({ sessionKey: "b" });
    expect(recs[0]!.reasons).toContain("recent-edit");
    expect(recs[0]!.confidence).not.toBe("high");
  });

  it("설정한 가중치를 쓴다: 이전 선택만 보면 이전에 고른 세션이 앞선다", () => {
    const sessions = [s({ key: "app", cwd: "/home/u/project/app" }), s({ key: "prev", cwd: "/home/u/project/other" })];
    expect(recommend({ ...base, previousSessionKey: "prev", sessions })[0]!.sessionKey).toBe("app");
    const weights = { source: 0, devServer: 0, recent: 0, topic: 0, previous: 1 };
    expect(recommend({ ...base, previousSessionKey: "prev", sessions, weights })[0]!.sessionKey).toBe("prev");
  });

  it("같은 폴더 세션 둘: 대화 주제가 요청과 겹치는 세션이 앞선다", () => {
    const recs = recommend({
      ...base,
      queryText: "결제 카드 레이아웃이 깨짐",
      sessions: [
        s({ key: "a", cwd: "/home/u/project/app", title: "로그인 API 리팩터링", recentPrompts: ["토큰 만료 처리"] }),
        s({ key: "b", cwd: "/home/u/project/app", title: "결제 화면 레이아웃", recentPrompts: ["카드 목록 간격 조정"] }),
      ],
    });
    expect(recs[0]!.sessionKey).toBe("b");
    expect(recs[0]!.reasons).toContain("topic");
  });

  it("응답 대기 중인 세션은 감점, 보낼 수 없는 세션은 제외, 신호 없으면 빈 결과", () => {
    const recs = recommend({
      ...base,
      sessions: [
        s({ key: "wait", cwd: "/home/u/project/app", status: "waiting" }),
        s({ key: "idle", cwd: "/home/u/project/app" }),
        s({ key: "bg", cwd: "/home/u/project/app", dispatchable: false }),
      ],
    });
    expect(recs.map((r) => r.sessionKey)).toEqual(["idle", "wait"]);
    expect(recommend({ ...base, sourceFile: null, devServerRoot: null, sessions: [s({ key: "x", cwd: "/elsewhere" })] })).toEqual([]);
  });

  it("이전 선택 가산점", () => {
    const recs = recommend({
      ...base,
      previousSessionKey: "a",
      sessions: [s({ key: "b", cwd: "/home/u/project/app" }), s({ key: "a", cwd: "/home/u/project/app" })],
    });
    expect(recs[0]).toMatchObject({ sessionKey: "a" });
    expect(recs[0]!.reasons).toContain("previous-choice");
  });
});

describe("토큰과 주제 점수", () => {
  it("한글 조사가 붙어도 앞부분 일치를 인정한다", () => {
    expect(tokenize("드롭다운이 잘림. AvatarMenu.tsx")).toEqual(["드롭다운이", "잘림", "avatarmenu"]);
    expect(topicScore(["드롭다운이"], ["드롭다운"])).toBe(1);
    expect(topicScore([], ["a"])).toBe(0);
  });
});

describe("dev 서버 포트 소유자", () => {
  it("ss 출력에서 리스너와 pid를 읽는다", () => {
    const out = [
      'LISTEN 0      511    127.0.0.1:5199 0.0.0.0:* users:(("MainThread",pid=305504,fd=24))',
      "LISTEN 0      4096   127.0.0.1:5432 0.0.0.0:*",
      'LISTEN 0      511    [::1]:3000 [::]:* users:(("node",pid=42,fd=3))',
    ].join("\n");
    expect(parseSsListeners(out)).toEqual([
      { address: "127.0.0.1", port: 5199, pid: 305504 },
      { address: "[::1]", port: 3000, pid: 42 },
    ]);
  });

  it("로컬 주소만 포트를 본다", () => {
    expect(localPort("http://127.0.0.1:5199/x")).toBe(5199);
    expect(localPort("http://localhost/")).toBe(80);
    expect(localPort("https://example.com:8443/")).toBeNull();
    expect(isUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isUnder("/a/bc", "/a/b")).toBe(false);
  });
});
