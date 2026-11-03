import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTracker, TranscriptTail, applyLine, assistantAfter, assistantReply, emptyActivity, hasPrompt, parseLine, projectSlug, recentPrompts, scanReply } from "./transcript.ts";

const at = (s: number) => new Date(1_800_000_000_000 + s * 1000).toISOString();
const user = (text: string, t: number, extra: object = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, timestamp: at(t), ...extra });
const assistant = (content: object[], t: number, stop: string | null = null) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content, stop_reason: stop }, timestamp: at(t) });

describe("parseLine", () => {
  it("사람이 친 프롬프트만 프롬프트로 받는다(나머지 메인 입력은 input)", () => {
    expect(parseLine(user("안녕", 1))).toMatchObject({ type: "prompt", text: "안녕" });
    expect(parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] }, timestamp: at(1) }))).toMatchObject({ type: "input" });
    expect(parseLine(user("<command-name>/clear</command-name>", 1))).toMatchObject({ type: "input" });
    expect(parseLine(user("서브에이전트", 1, { isSidechain: true }))).toBeNull();
  });

  it("origin 없는 기록(VS Code 확장 추정)도 받되, 앞에 붙은 <ide_…> 블록은 걷고, 다른 origin·메타는 뺀다", () => {
    const vscode = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>The user opened src/a.ts</ide_opened_file>" }, { type: "text", text: "[switchboard #3] 고쳐줘" }] },
      timestamp: at(1),
    });
    expect(parseLine(vscode)).toMatchObject({ type: "prompt", text: "[switchboard #3] 고쳐줘" });
    expect(parseLine(user("다른 세션이 보냄", 1, { origin: { kind: "peer" } }))).toMatchObject({ type: "input" });
    expect(parseLine(user("메타", 1, { isMeta: true }))).toMatchObject({ type: "input" });
    expect(parseLine(user("[Request interrupted by user]", 1, { origin: undefined }))).toMatchObject({ type: "input" });
  });

  it("메인 턴 끝: 마지막 응답이 end_turn이고 그 뒤 입력이 없을 때만 (백그라운드 에이전트가 돌아도 입력칸은 빔)", () => {
    const a = emptyActivity();
    const feed = (line: string) => {
      const p = parseLine(line);
      if (p) applyLine(a, p);
    };
    feed(user("[switchboard #8] 감사해 줘", 1));
    expect(a.turnEndedAt).toBeUndefined();
    feed(assistant([{ type: "tool_use", name: "Agent", input: {} }], 2, "tool_use"));
    feed(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "launched in background" }] }, timestamp: at(3) }));
    expect(a.turnEndedAt).toBeUndefined();
    // 실측(2.1.317): 생각 줄과 텍스트 줄이 따로, 둘 다 end_turn
    feed(assistant([{ type: "thinking", thinking: "" }], 4, "end_turn"));
    feed(assistant([{ type: "text", text: "에이전트 결과가 오면 정리하겠습니다" }], 4, "end_turn"));
    feed(JSON.stringify({ type: "system", subtype: "stop_hook_summary", timestamp: at(4) }));
    expect(a.turnEndedAt).toBe(Date.parse(at(4)));
    // 에이전트 완료 알림 → 메인 턴이 다시 돈다
    feed(user("<task-notification>done</task-notification>", 5, { origin: { kind: "task-notification" } }));
    expect(a.turnEndedAt).toBeUndefined();
    feed(assistant([{ type: "text", text: "정리" }], 6, "end_turn"));
    expect(a.turnEndedAt).toBe(Date.parse(at(6)));
    feed(user("다음 요청", 7));
    expect(a.turnEndedAt).toBeUndefined();
    // 스트리밍 중(stop_reason 없음)은 진행 중
    feed(assistant([{ type: "text", text: "…" }], 8, null));
    expect(a.turnEndedAt).toBeUndefined();
  });

  it("긴 붙여넣기의 <pasted_content> 감싸기를 벗긴다 (실측 형식)", () => {
    // Claude Code v2.1.316 실제 기록 그대로(닫는 태그에도 id)
    const content = '\n\n<pasted_content id="96cb">\n[switchboard #2] 전달 테스트\n\n- 대상: src/Card.tsx:~10\n</pasted_content id="96cb">\n';
    expect(parseLine(user(content, 1))).toMatchObject({ type: "prompt", text: "[switchboard #2] 전달 테스트\n\n- 대상: src/Card.tsx:~10" });
  });

  it("응답 텍스트와 파일 도구 호출", () => {
    const p = parseLine(
      assistant(
        [
          { type: "thinking", thinking: "" },
          { type: "text", text: "고쳤습니다" },
          { type: "tool_use", name: "Edit", input: { file_path: "/r/a.tsx" } },
          { type: "tool_use", name: "Read", input: { file_path: "/r/b.tsx" } },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
        2,
      ),
    );
    expect(p).toMatchObject({ type: "assistant", texts: ["고쳤습니다"], files: [{ path: "/r/a.tsx", op: "edit" }, { path: "/r/b.tsx", op: "read" }] });
  });

  it("제목, 관심 없는 줄, 깨진 줄", () => {
    expect(parseLine(JSON.stringify({ type: "ai-title", aiTitle: "결제 화면" }))).toEqual({ type: "title", title: "결제 화면" });
    expect(parseLine(JSON.stringify({ type: "cost-state", totalCostUSD: 1 }))).toBeNull();
    expect(parseLine('{"type":"user", broken')).toBeNull();
  });
});

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptTail", () => {
  it("증분으로 읽고, 처음엔 끝부분만 읽으며 잘린 첫 줄은 버린다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const f = join(dir, "s.jsonl");
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(300) }, origin: { kind: "human" }, timestamp: at(0) });
    writeFileSync(f, `${filler}\n${user("첫 질문", 1)}\n`);
    // 끝에서 250바이트: 긴 첫 줄 중간에서 시작하므로 그 조각은 버리고 마지막 줄만 읽어야 한다.
    const tail = new TranscriptTail(f, { initialBytes: 250 });
    await tail.poll();
    expect(recentPrompts(tail.activity)).toEqual(["첫 질문"]);

    appendFileSync(f, `${user("[switchboard #3] 드롭다운", 2)}\n${assistant([{ type: "text", text: "확인했습니다" }], 3)}\n`);
    expect(await tail.poll()).toBe(true);
    expect(hasPrompt(tail.activity, "[switchboard #3]")).toBe(true);
    expect(assistantAfter(tail.activity, "[switchboard #3]")).toBe("확인했습니다");
    expect(await tail.poll()).toBe(false);
  });

  it("줄이 중간에 끊겨 들어와도 다음 읽기에서 이어 붙인다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const f = join(dir, "s.jsonl");
    const line = user("나눠 쓴 줄", 1);
    writeFileSync(f, line.slice(0, 20));
    const tail = new TranscriptTail(f);
    await tail.poll();
    expect(tail.activity.events).toHaveLength(0);
    appendFileSync(f, `${line.slice(20)}\n`);
    await tail.poll();
    expect(recentPrompts(tail.activity)).toEqual(["나눠 쓴 줄"]);
  });

  it("다음 프롬프트가 오기 전 응답만 요약으로 쓴다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(f, [user("[switchboard #1] a", 1), user("다른 질문", 2), assistant([{ type: "text", text: "다른 답" }], 3)].join("\n") + "\n");
    const tail = new TranscriptTail(f);
    await tail.poll();
    expect(assistantAfter(tail.activity, "[switchboard #1]")).toBeUndefined();
  });
});

describe("ActivityTracker", () => {
  it("cwd 슬러그로 기록 파일을 찾아 세션 정보를 채운다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const cwd = "/home/u/app";
    const projDir = join(dir, "projects", projectSlug(cwd));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "sid-1.jsonl"),
      [
        JSON.stringify({ type: "ai-title", aiTitle: "결제 화면" }),
        user("카드 간격", 1),
        assistant([{ type: "text", text: "간격을 줄였습니다" }, { type: "tool_use", name: "Edit", input: { file_path: "/home/u/app/src/Card.tsx" } }], 2),
      ].join("\n") + "\n",
    );
    expect(projectSlug("/home/u/my.app")).toBe("-home-u-my-app");
    const tracker = new ActivityTracker(dir);
    const snap = await tracker.enrich({
      takenAt: 0,
      tmuxRunning: true,
      warnings: [],
      sessions: [{ key: "sid-1", sessionId: "sid-1", name: "app", kind: "interactive", cwd, startedAt: 0, dispatchable: true, recentPrompts: [], recentFiles: [] }],
    });
    expect(snap.sessions[0]).toMatchObject({
      title: "결제 화면",
      recentPrompts: ["카드 간격"],
      lastAssistantSummary: "간격을 줄였습니다",
      recentFiles: [{ path: "/home/u/app/src/Card.tsx", op: "edit" }],
    });
  });
});

describe("최종 답변", () => {
  it("마지막 도구 호출 뒤의 텍스트만 이어 붙인다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const f = join(dir, "s.jsonl");
    writeFileSync(
      f,
      [
        user("[switchboard #9] 표로 정리해줘", 1),
        assistant([{ type: "text", text: "확인해 보겠습니다." }, { type: "tool_use", name: "Read", input: { file_path: "/r/a.tsx" } }], 2),
        assistant([{ type: "text", text: "## 결과" }], 3),
        assistant([{ type: "text", text: "| 항목 | 값 |\n| --- | --- |\n| a | 1 |" }], 4),
        user("다음 질문", 5),
        assistant([{ type: "text", text: "다른 답" }], 6),
      ].join("\n") + "\n",
    );
    const tail = new TranscriptTail(f);
    await tail.poll();
    expect(assistantReply(tail.activity, "[switchboard #9]")).toBe("## 결과\n\n| 항목 | 값 |\n| --- | --- |\n| a | 1 |");
    expect(assistantReply(tail.activity, "[switchboard #404]")).toBeUndefined();
  });
});

describe("백그라운드 에이전트가 끼는 턴 (실측 2.1.317 순서)", () => {
  // 에이전트 완료 메시지는 origin 없이 user 줄로 온다
  const peer = (t: number) => JSON.stringify({ type: "user", message: { role: "user", content: 'Another Claude session sent a message: <teammate-message teammate_id="docs-research">요약</teammate-message>' }, timestamp: at(t) });
  const lines = [
    user("[switchboard #8] 감사해 줘", 1),
    assistant([{ type: "tool_use", name: "Agent", input: {} }], 2, "tool_use"),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "launched" }] }, timestamp: at(3) }),
    assistant([{ type: "text", text: "리서치 에이전트가 아직 읽는 중입니다." }], 4, "end_turn"),
    peer(10),
    assistant([{ type: "text", text: "결과가 도착했습니다." }, { type: "tool_use", name: "Bash", input: {} }], 11, "tool_use"),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] }, timestamp: at(12) }),
    assistant([{ type: "text", text: "감사 결과입니다." }], 13, "end_turn"),
    peer(14),
    assistant([{ type: "text", text: "완료 알림이라 새로 할 일은 없습니다." }], 15, "end_turn"),
    user("[switchboard #9] 토글도", 16),
    assistant([{ type: "text", text: "토글 답" }], 17, "end_turn"),
  ];

  it("에이전트 메시지는 프롬프트가 아니다: 최종 답변이 에이전트 뒤의 결과까지 간다", () => {
    expect(parseLine(peer(1))).toMatchObject({ type: "input" });
    const a = emptyActivity();
    for (const l of lines) {
      const p = parseLine(l);
      if (p) applyLine(a, p);
    }
    expect(recentPrompts(a)).toEqual(["[switchboard #8] 감사해 줘", "[switchboard #9] 토글도"]);
    expect(assistantReply(a, "[switchboard #8]")).toBe("감사 결과입니다.\n\n완료 알림이라 새로 할 일은 없습니다.");
  });

  it("origin을 적는 기록에서는 origin 없는 user 줄을 프롬프트로 치지 않는다", () => {
    const a = emptyActivity();
    for (const l of [user("사람", 1), JSON.stringify({ type: "user", message: { role: "user", content: "알 수 없는 출처" }, timestamp: at(2) })]) {
      const p = parseLine(l);
      if (p) applyLine(a, p);
    }
    expect(recentPrompts(a)).toEqual(["사람"]);
  });

  it("꼬리에 프롬프트가 없으면(재시작 뒤) 파일 전체에서 찾는다", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-tr-"));
    const cwd = "/home/u/app";
    mkdirSync(join(dir, "projects", projectSlug(cwd)), { recursive: true });
    const f = join(dir, "projects", projectSlug(cwd), "sid-8.jsonl");
    // 프롬프트 뒤에 큰 줄을 끼워 꼬리(4MB) 밖으로 밀어낸다
    const filler = assistant([{ type: "text", text: "x".repeat(5 * 1024 * 1024) }, { type: "tool_use", name: "Read", input: {} }], 3, "tool_use");
    writeFileSync(f, [lines[0], lines[1], lines[2], filler, ...lines.slice(3)].join("\n") + "\n");
    const tracker = new ActivityTracker(dir);
    const a = await tracker.get("sid-8", cwd);
    expect(hasPrompt(a!, "[switchboard #8]")).toBe(false);
    expect(await tracker.reply("sid-8", cwd, "[switchboard #8]")).toBe("감사 결과입니다.\n\n완료 알림이라 새로 할 일은 없습니다.");
    expect(await tracker.reply("sid-8", cwd, "[switchboard #9]")).toBe("토글 답");
    expect(await scanReply(f, "[switchboard #404]")).toBeUndefined();
  });
});
