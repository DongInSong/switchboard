import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTracker, TranscriptTail, assistantAfter, assistantReply, hasPrompt, parseLine, projectSlug, recentPrompts } from "./transcript.ts";

const at = (s: number) => new Date(1_800_000_000_000 + s * 1000).toISOString();
const user = (text: string, t: number, extra: object = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, timestamp: at(t), ...extra });
const assistant = (content: object[], t: number) => JSON.stringify({ type: "assistant", message: { role: "assistant", content }, timestamp: at(t) });

describe("parseLine", () => {
  it("사람이 친 프롬프트만 받는다", () => {
    expect(parseLine(user("안녕", 1))).toMatchObject({ type: "prompt", text: "안녕" });
    expect(parseLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] }, timestamp: at(1) }))).toBeNull();
    expect(parseLine(user("<command-name>/clear</command-name>", 1))).toBeNull();
    expect(parseLine(user("서브에이전트", 1, { isSidechain: true }))).toBeNull();
  });

  it("origin 없는 기록(VS Code 확장 추정)도 받되, 앞에 붙은 <ide_…> 블록은 걷고, 다른 origin·메타는 뺀다", () => {
    const vscode = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>The user opened src/a.ts</ide_opened_file>" }, { type: "text", text: "[switchboard #3] 고쳐줘" }] },
      timestamp: at(1),
    });
    expect(parseLine(vscode)).toMatchObject({ type: "prompt", text: "[switchboard #3] 고쳐줘" });
    expect(parseLine(user("다른 세션이 보냄", 1, { origin: { kind: "peer" } }))).toBeNull();
    expect(parseLine(user("메타", 1, { isMeta: true }))).toBeNull();
    expect(parseLine(user("[Request interrupted by user]", 1, { origin: undefined }))).toBeNull();
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
