import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecentFile, Session, SessionSnapshot } from "@switchboard/protocol";

/**
 * Claude Code 대화 기록(JSONL) 꼬리 읽기.
 * 공식 문서가 "내부 포맷, 버전마다 바뀜"이라고 밝힌 파일이므로 이 모듈 하나에 가두고, 못 읽어도 다른 기능은 그대로 둔다.
 * 필요한 것만 뽑는다: 제목, 사람이 친 프롬프트, 파일 도구 호출, Claude 응답 텍스트.
 */

export type ActivityEvent =
  | { kind: "prompt"; text: string; at: number }
  | { kind: "assistant"; text: string; at: number }
  /** 도구 호출 경계. 최종 답변 = 턴의 마지막 도구 호출 뒤 텍스트. */
  | { kind: "tool"; at: number };

export type Activity = {
  title: string | undefined;
  events: ActivityEvent[];
  files: RecentFile[];
  lastActivityAt: number | undefined;
};

const MAX_EVENTS = 240;
const MAX_FILES = 60;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Loose) : null);

export function unwrapPasted(text: string): string {
  // 닫는 태그에도 id가 붙는다: </pasted_content id="96cb">
  return text.replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, "$1");
}

export type ParsedLine =
  | { type: "title"; title: string }
  | { type: "prompt"; text: string; at: number }
  | { type: "assistant"; texts: string[]; files: RecentFile[]; at: number; blocks: ("text" | "tool")[] };

/** 한 줄 파싱. 관심 없는 줄은 JSON.parse 전에 걸러 낸다(줄이 수 MB인 경우가 있음). */
export function parseLine(line: string): ParsedLine | null {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"ai-title"')) return null;
  let d: Loose;
  try {
    d = JSON.parse(line) as Loose;
  } catch {
    return null;
  }
  if (d.type === "ai-title" && typeof d.aiTitle === "string") return { type: "title", title: d.aiTitle };
  if (d.isSidechain === true) return null;
  const at = typeof d.timestamp === "string" ? Date.parse(d.timestamp) || 0 : 0;
  const message = obj(d.message);
  if (d.type === "user") {
    // 사람이 친 프롬프트만. CLI는 origin.kind가 "human". VS Code 확장 기록은 origin이 없을 수 있어 받되,
    // 다른 origin(다른 세션 메시지 등)·메타·요약·도구 결과는 뺀다. 앞에 붙는 <ide_…>·<system-reminder> 블록은 걷어 낸다.
    const origin = obj(d.origin)?.kind;
    if (origin !== undefined && origin !== "human") return null;
    if (d.isMeta === true || d.isCompactSummary === true) return null;
    const content = message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      if (content.some((b) => obj(b)?.type === "tool_result")) return null;
      text = content
        .map((b) => (obj(b)?.type === "text" ? String(obj(b)?.text ?? "") : ""))
        .filter((t) => !/^\s*<(ide_[a-z_]+|system-reminder)>/.test(t))
        .join("\n");
    }
    // 긴 붙여넣기는 <pasted_content id="…">…</pasted_content>로 감싸 저장된다(실측 v2.1.316). 안쪽 내용을 쓴다.
    text = unwrapPasted(text).trim();
    if (!text || text.startsWith("<") || text.startsWith("[Request interrupted")) return null;
    return { type: "prompt", text, at };
  }
  if (d.type === "assistant" && Array.isArray(message?.content)) {
    const texts: string[] = [];
    const files: RecentFile[] = [];
    const blocks: ("text" | "tool")[] = [];
    for (const raw of message.content as unknown[]) {
      const b = obj(raw);
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts.push(b.text.trim());
        blocks.push("text");
      }
      if (b.type === "tool_use") blocks.push("tool");
      if (b.type === "tool_use" && typeof b.name === "string") {
        const input = obj(b.input);
        const path = input?.file_path ?? input?.notebook_path;
        if (typeof path !== "string") continue;
        if (EDIT_TOOLS.has(b.name)) files.push({ path, op: b.name === "Write" ? "write" : "edit", at });
        else if (b.name === "Read") files.push({ path, op: "read", at });
      }
    }
    if (blocks.length === 0) return null;
    return { type: "assistant", texts, files, at, blocks };
  }
  return null;
}

export function emptyActivity(): Activity {
  return { title: undefined, events: [], files: [], lastActivityAt: undefined };
}

export function applyLine(a: Activity, p: ParsedLine): void {
  if (p.type === "title") {
    a.title = p.title;
    return;
  }
  if (p.at) a.lastActivityAt = Math.max(a.lastActivityAt ?? 0, p.at);
  if (p.type === "prompt") a.events.push({ kind: "prompt", text: p.text, at: p.at });
  else {
    let ti = 0;
    for (const b of p.blocks) {
      if (b === "text") a.events.push({ kind: "assistant", text: p.texts[ti++]!, at: p.at });
      else a.events.push({ kind: "tool", at: p.at });
    }
    a.files.push(...p.files);
  }
  if (a.events.length > MAX_EVENTS) a.events.splice(0, a.events.length - MAX_EVENTS);
  if (a.files.length > MAX_FILES) a.files.splice(0, a.files.length - MAX_FILES);
}

export function recentPrompts(a: Activity, n = 5): string[] {
  return a.events.filter((e) => e.kind === "prompt").slice(-n).map((e) => e.text);
}

/** 마커가 든 프롬프트가 기록에 있는지. */
export function hasPrompt(a: Activity, marker: string): boolean {
  return a.events.some((e) => e.kind === "prompt" && e.text.includes(marker));
}

/** 마커가 든 프롬프트의 턴(다음 프롬프트 전까지)에서 Claude의 마지막 응답 텍스트. */
/**
 * 마커 프롬프트 턴의 최종 답변: 마지막 도구 호출 뒤의 텍스트를 모두 이어 붙인다.
 * (도구 호출 사이의 "확인해 보겠습니다" 같은 중간 말은 빠진다)
 */
export function assistantReply(a: Activity, marker: string): string | undefined {
  let idx = -1;
  a.events.forEach((e, i) => {
    if (e.kind === "prompt" && e.text.includes(marker)) idx = i;
  });
  if (idx < 0) return undefined;
  let end = a.events.length;
  for (let i = idx + 1; i < a.events.length; i++) {
    if (a.events[i]!.kind === "prompt") {
      end = i;
      break;
    }
  }
  const turn = a.events.slice(idx + 1, end);
  let lastTool = -1;
  turn.forEach((e, i) => {
    if (e.kind === "tool") lastTool = i;
  });
  const texts = turn.slice(lastTool + 1).flatMap((e) => (e.kind === "assistant" ? [e.text] : []));
  return texts.length ? texts.join("\n\n") : undefined;
}

export function assistantAfter(a: Activity, marker: string): string | undefined {
  let idx = -1;
  a.events.forEach((e, i) => {
    if (e.kind === "prompt" && e.text.includes(marker)) idx = i;
  });
  if (idx < 0) return undefined;
  let last: string | undefined;
  for (let i = idx + 1; i < a.events.length; i++) {
    const e = a.events[i]!;
    if (e.kind === "prompt") break;
    if (e.kind === "assistant") last = e.text;
  }
  return last;
}

/** 파일 하나의 꼬리를 증분으로 읽는다. 처음에는 끝에서 initialBytes만 읽는다. */
export class TranscriptTail {
  readonly file: string;
  readonly activity: Activity = emptyActivity();
  #offset = -1;
  #rest = "";
  readonly #initialBytes: number;
  readonly #maxPerPoll: number;

  constructor(file: string, opts: { initialBytes?: number; maxPerPoll?: number } = {}) {
    this.file = file;
    this.#initialBytes = opts.initialBytes ?? 4 * 1024 * 1024;
    this.#maxPerPoll = opts.maxPerPoll ?? 16 * 1024 * 1024;
  }

  async poll(): Promise<boolean> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return false;
    }
    let skipPartial = false;
    if (this.#offset < 0 || size < this.#offset) {
      this.#offset = Math.max(0, size - this.#initialBytes);
      skipPartial = this.#offset > 0;
      this.#rest = "";
    }
    if (size === this.#offset) return false;
    const len = Math.min(size - this.#offset, this.#maxPerPoll);
    const fh = await open(this.file, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, this.#offset);
      chunk = buf.subarray(0, bytesRead).toString("utf8");
      this.#offset += bytesRead;
    } finally {
      await fh.close();
    }
    let text = this.#rest + chunk;
    if (skipPartial) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines = text.split("\n");
    this.#rest = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      const p = parseLine(line);
      if (p) {
        applyLine(this.activity, p);
        changed = true;
      }
    }
    return changed;
  }
}

/** cwd → `~/.claude/projects/<slug>` 이름. 영숫자 외 문자를 '-'로. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class ActivityTracker {
  readonly #projectsDir: string;
  readonly #tails = new Map<string, TranscriptTail>();

  constructor(configDir: string) {
    this.#projectsDir = join(configDir, "projects");
  }

  async #locate(sessionId: string, cwd: string): Promise<string | null> {
    const direct = join(this.#projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
    try {
      await stat(direct);
      return direct;
    } catch {
      /* 긴 경로는 해시가 붙으므로 전체를 훑는다 */
    }
    try {
      for (const dir of await readdir(this.#projectsDir)) {
        const f = join(this.#projectsDir, dir, `${sessionId}.jsonl`);
        try {
          await stat(f);
          return f;
        } catch {
          /* 다음 */
        }
      }
    } catch {
      /* projects 없음 */
    }
    return null;
  }

  async get(sessionId: string, cwd: string): Promise<Activity | null> {
    let tail = this.#tails.get(sessionId);
    if (!tail) {
      const file = await this.#locate(sessionId, cwd);
      if (!file) return null;
      tail = new TranscriptTail(file);
      this.#tails.set(sessionId, tail);
    }
    await tail.poll();
    return tail.activity;
  }

  /** 레지스트리 스냅샷에 활동 정보를 채운다. */
  async enrich(snap: SessionSnapshot): Promise<SessionSnapshot> {
    const sessions = await Promise.all(snap.sessions.map((s) => this.#enrichOne(s)));
    return { ...snap, sessions };
  }

  async #enrichOne(s: Session): Promise<Session> {
    if (!s.sessionId) return s;
    const a = await this.get(s.sessionId, s.cwd).catch(() => null);
    if (!a) return s;
    const lastAssistant = [...a.events].reverse().find((e) => e.kind === "assistant");
    const out: Session = {
      ...s,
      recentPrompts: recentPrompts(a).map((t) => (t.length > 300 ? `${t.slice(0, 299)}…` : t)),
      recentFiles: a.files.slice(-20),
    };
    if (a.title) out.title = a.title;
    if (lastAssistant) out.lastAssistantSummary = lastAssistant.text.length > 600 ? `${lastAssistant.text.slice(0, 599)}…` : lastAssistant.text;
    if (a.lastActivityAt) out.lastActivityAt = a.lastActivityAt;
    return out;
  }
}
