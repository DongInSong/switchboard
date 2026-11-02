import { EventEmitter } from "node:events";
import type { Dispatch, Session, SessionSnapshot } from "@switchboard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyActivity, type Activity } from "../activity/transcript.ts";
import type { ProcStat } from "../registry/proc.ts";
import { Store } from "../store.ts";
import { sampleCapture } from "../testing/fixtures.ts";
import { Dispatcher, summarize } from "./dispatcher.ts";
import { inputHasPaste, isPlaceholderLine, readInputBox } from "./screen.ts";
import type { PaneInfo, TmuxLike } from "./tmux-driver.ts";

const RULE = "─".repeat(60);
function screen(input: string, extraAbove = "● 이전 응답"): string {
  const [first = "", ...rest] = input.split("\n");
  return [extraAbove, RULE, `❯ ${first}`, ...rest.map((l) => `  ${l}`), RULE, "  ╭╴◆ Haiku", "  ⏵⏵ auto mode on"].join("\n");
}

describe("readInputBox", () => {
  it("빈 입력칸, 글이 있는 입력칸, 여러 줄", () => {
    expect(readInputBox(screen(""))).toEqual({ state: "empty", text: "" });
    expect(readInputBox(screen("abc 치다 만 글"))).toEqual({ state: "text", text: "abc 치다 만 글" });
    expect(readInputBox(screen("[switchboard #3] 줄1\n- 줄2")).text).toBe("[switchboard #3] 줄1\n- 줄2");
  });

  it("기록에 남은 예전 ❯ 줄이 아니라 맨 아래 입력칸을 본다", () => {
    const s = screen("", ["❯ 예전 프롬프트", "● 응답"].join("\n"));
    expect(readInputBox(s).state).toBe("empty");
  });

  it("대화상자처럼 입력칸 모양이 아니면 unknown", () => {
    expect(readInputBox(["Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n")).state).toBe("unknown");
    expect(readInputBox([RULE, " Allow this edit?", RULE].join("\n")).state).toBe("unknown");
  });

  it("흐린 안내 문구(placeholder)는 빈 칸으로 본다", () => {
    const raw = [RULE, '❯ \x1b[2mTry "fix lint errors"\x1b[22m', RULE, "  status"].join("\n");
    expect(isPlaceholderLine('❯ \x1b[2mTry "x"')).toBe(true);
    expect(isPlaceholderLine("❯ hello")).toBe(false);
    expect(readInputBox(raw).state).toBe("empty");
  });

  it("붙여넣기 확인: 마커가 보이거나 접힌 붙여넣기 표시", () => {
    expect(inputHasPaste(readInputBox(screen("[switchboard #7] 요청")), "[switchboard #7]")).toBe(true);
    expect(inputHasPaste(readInputBox(screen("[Pasted text #1 +7 lines]")), "[switchboard #7]")).toBe(true);
    expect(inputHasPaste(readInputBox(screen("")), "[switchboard #7]")).toBe(false);
  });
});

// ---------------------------------------------------------------- 가짜 세계

class FakeWorld {
  status: "idle" | "busy" | "waiting" = "idle";
  input = "";
  dialog = false;
  pasteWorks = true;
  enterWorks = true;
  /** Enter를 받으면 이 시간 뒤 busy → reply 남기고 idle */
  submitted: string[] = [];
  activity: Activity = emptyActivity();
  registry = new (class extends EventEmitter {
    readonly w: FakeWorld;
    constructor(w: FakeWorld) {
      super();
      this.w = w;
    }
    get snapshot(): SessionSnapshot {
      return this.w.snapshot();
    }
    async refresh() {
      return this.w.snapshot();
    }
  })(this);

  session(): Session {
    return {
      key: "s1",
      sessionId: "sid-1",
      name: "app-71",
      kind: "interactive",
      cwd: "/repo",
      startedAt: 1,
      pid: 500,
      procStart: "777",
      status: this.status,
      dispatchable: true,
      tmux: { session: "t", windowId: "@1", windowIndex: 0, paneId: "%4", paneCommand: "claude", inMode: false, via: "ancestry" },
      recentPrompts: [],
      recentFiles: [],
    };
  }

  snapshot(): SessionSnapshot {
    return { sessions: [this.session()], takenAt: Date.now(), tmuxRunning: true, warnings: [] };
  }

  setStatus(s: FakeWorld["status"]) {
    this.status = s;
    this.registry.emit("change", this.snapshot());
  }

  tmux: TmuxLike = {
    paneInfo: async (id): Promise<PaneInfo | null> => (id === "%4" ? { paneId: "%4", panePid: 400, command: "claude", inMode: false, dead: false } : null),
    capture: async () => (this.dialog ? "Allow?\n❯ 1. Yes" : screen(this.input)),
    paste: async (_id, text) => {
      if (!this.pasteWorks) return true; // 명령은 성공했지만 화면에 안 들어감
      this.input = text;
      return true;
    },
    enter: async () => {
      if (!this.enterWorks) return true;
      const text = this.input;
      this.input = "";
      this.submitted.push(text);
      this.activity.events.push({ kind: "prompt", text, at: Date.now() });
      this.setStatus("busy");
      setTimeout(() => {
        this.activity.events.push({ kind: "assistant", text: "드롭다운 위치를 고쳤습니다.", at: Date.now() });
        this.setStatus("idle");
      }, 30);
      return true;
    },
  };

  readStat = async (pid: number): Promise<ProcStat | null> =>
    pid === 500 ? { pid: 500, comm: "claude", ppid: 400, startTime: "777" } : pid === 400 ? { pid: 400, comm: "bash", ppid: 1, startTime: "1" } : null;
}

const FAST = { pasteDelayMs: 2, pasteVisibleMs: 30, verifyTimeoutMs: 200, verifyPollMs: 5, waitPollMs: 20, goneGraceMs: 60 };

let store: Store;
let world: FakeWorld;
let updates: Dispatch[];
let dispatcher: Dispatcher;

function setup() {
  store = new Store(":memory:");
  world = new FakeWorld();
  updates = [];
  dispatcher = new Dispatcher({
    store,
    registry: world.registry,
    tmux: world.tmux,
    activity: { get: async () => world.activity },
    readStat: world.readStat,
    onUpdate: (d) => updates.push(d),
    config: FAST,
  });
}

function newRequest(prompt: string): number {
  const capId = `c-${Math.random().toString(36).slice(2)}`;
  store.insertCapture({ id: capId, createdAt: 1, url: "http://localhost:5199/", origin: "http://localhost:5199", title: "t", dir: "/tmp/c", capture: sampleCapture() });
  const id = store.reserveRequest(capId, "text", "s1", 1);
  store.fillRequest(id, prompt.replace("#N", `#${id}`), "/tmp/c/context.md");
  return id;
}

async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(setup);
afterEach(async () => {
  dispatcher.stop();
  await new Promise((r) => setTimeout(r, 60));
  store.close();
});

describe("Dispatcher", () => {
  it("유휴 세션: 붙여넣기 → 확인 → Enter → 작업 중 → 완료(응답 요약)", async () => {
    const id = newRequest("[switchboard #N] 드롭다운이 잘림\n- 대상: src/A.tsx");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.state === "done");
    const final = store.getDispatch(d.id)!;
    expect(final.summary).toBe("드롭다운 위치를 고쳤습니다.");
    expect(final.deliveredAt).not.toBeNull();
    expect(world.submitted).toEqual([`[switchboard #${id}] 드롭다운이 잘림\n- 대상: src/A.tsx`]);
    const states = updates.map((u) => u.state);
    expect(states[0]).toBe("queued");
    expect(states).toContain("delivering");
    expect(states.at(-1)).toBe("done");
  });

  it("VS Code 세션: 탭을 띄우고 붙여넣기를 기다렸다가, 기록에 마커가 보이면 추적 → 완료", async () => {
    const opened: string[] = [];
    dispatcher.stop();
    dispatcher = new Dispatcher({
      store,
      registry: world.registry,
      tmux: world.tmux,
      activity: { get: async () => world.activity },
      readStat: world.readStat,
      onUpdate: (d) => updates.push(d),
      config: FAST,
      openSession: async (s) => {
        opened.push(s.sessionId!);
        return true;
      },
    });
    const vs = { ...world.session(), tmux: undefined, surface: "vscode" as const, delivery: "vscode" as const };
    world.session = () => ({ ...vs, status: world.status });
    const id = newRequest("[switchboard #N] 버튼 색");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.waitReason === "paste");
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual(["sid-1"]);
    expect(store.getDispatch(d.id)?.state).toBe("queued");
    expect(world.submitted).toEqual([]); // tmux로는 아무것도 안 함
    // 사용자가 VS Code에 붙여 넣고 Enter
    world.activity.events.push({ kind: "prompt", text: `[switchboard #${id}] 버튼 색`, at: Date.now() });
    world.setStatus("busy");
    await until(() => store.getDispatch(d.id)?.state === "working");
    world.activity.events.push({ kind: "assistant", text: "색을 맞췄습니다.", at: Date.now() });
    world.setStatus("idle");
    await until(() => store.getDispatch(d.id)?.state === "done");
    expect(store.getDispatch(d.id)?.summary).toBe("색을 맞췄습니다.");
  });

  it("VS Code 세션: 붙여 넣지 않으면 시간 초과로 실패, 대기 중엔 취소 가능", async () => {
    dispatcher.stop();
    dispatcher = new Dispatcher({ store, registry: world.registry, tmux: world.tmux, activity: { get: async () => world.activity }, readStat: world.readStat, config: { ...FAST, pasteTimeoutMs: 80 } });
    const vs = { ...world.session(), tmux: undefined, delivery: "vscode" as const };
    world.session = () => vs;
    const a = dispatcher.enqueue(newRequest("[switchboard #N] a"), vs, "wait-idle", "[switchboard #999]");
    await until(() => store.getDispatch(a.id)?.state === "failed");
    expect(store.getDispatch(a.id)?.error).toBe("붙여 넣지 않음(시간 초과)");
    dispatcher.stop();
    dispatcher = new Dispatcher({ store, registry: world.registry, tmux: world.tmux, activity: { get: async () => world.activity }, readStat: world.readStat, config: FAST });
    const b = dispatcher.enqueue(newRequest("[switchboard #N] b"), vs, "wait-idle", "[switchboard #998]");
    await until(() => store.getDispatch(b.id)?.waitReason === "paste");
    expect(dispatcher.cancel(b.id)?.state).toBe("cancelled");
  });

  it("작업 중이면 예약으로 기다렸다가 유휴가 되면 보낸다", async () => {
    world.setStatus("busy");
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.waitReason === "busy");
    expect(world.submitted).toEqual([]);
    world.setStatus("idle");
    await until(() => store.getDispatch(d.id)?.state === "done");
    expect(world.submitted).toHaveLength(1);
  });

  it("응답 대기(권한 확인) 중에는 절대 입력하지 않는다", async () => {
    world.setStatus("waiting");
    world.dialog = true;
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.waitReason === "waiting");
    await new Promise((r) => setTimeout(r, 60));
    expect(world.submitted).toEqual([]);
    expect(world.input).toBe("");
    // 사용자가 터미널에서 응답 → 유휴
    world.dialog = false;
    world.setStatus("idle");
    await until(() => store.getDispatch(d.id)?.state === "done");
  });

  it("status가 유휴여도 화면이 대화상자면 입력하지 않는다", async () => {
    world.dialog = true;
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.waitReason === "unknown-screen");
    expect(world.submitted).toEqual([]);
    dispatcher.cancel(d.id);
    expect(store.getDispatch(d.id)?.state).toBe("cancelled");
  });

  it("사용자가 치다 만 글이 있으면 덮어쓰지 않고 기다린다", async () => {
    world.input = "내가 치던 글";
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.waitReason === "input");
    expect(world.input).toBe("내가 치던 글");
    world.input = "";
    world.registry.emit("change", world.snapshot());
    await until(() => store.getDispatch(d.id)?.state === "done");
  });

  it("붙여 넣은 내용이 안 보이면 Enter를 누르지 않고 실패", async () => {
    world.pasteWorks = false;
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.state === "failed");
    expect(store.getDispatch(d.id)?.error).toContain("입력하지 않음");
    expect(world.submitted).toEqual([]);
  });

  it("제출이 확인되지 않으면 Enter를 다시 보내지 않고 실패로 남긴다", async () => {
    world.enterWorks = false;
    const id = newRequest("[switchboard #N] a");
    const d = dispatcher.enqueue(id, world.session(), "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.state === "failed");
    expect(store.getDispatch(d.id)?.error).toContain("확인 안 됨");
  });

  it("세션이 사라지면 잠시 기다린 뒤 실패", async () => {
    const id = newRequest("[switchboard #N] a");
    const gone = { ...world.session(), key: "nope" };
    const d = dispatcher.enqueue(id, gone, "wait-idle", `[switchboard #${id}]`);
    await until(() => store.getDispatch(d.id)?.state === "failed");
    expect(store.getDispatch(d.id)?.error).toBe("세션이 없음");
  });

  it("같은 세션의 요청은 순서대로 하나씩", async () => {
    const a = newRequest("[switchboard #N] 첫째");
    const b = newRequest("[switchboard #N] 둘째");
    const da = dispatcher.enqueue(a, world.session(), "wait-idle", `[switchboard #${a}]`);
    const db = dispatcher.enqueue(b, world.session(), "wait-idle", `[switchboard #${b}]`);
    await until(() => store.getDispatch(db.id)?.state === "done" && store.getDispatch(da.id)?.state === "done", 4000);
    expect(world.submitted.map((t) => t.split(" ").slice(2).join(" "))).toEqual(["첫째", "둘째"]);
  });

  it("재시작 복구: 입력 도중이던 것은 실패, 예약은 다시 처리", async () => {
    const a = newRequest("[switchboard #N] a");
    const b = newRequest("[switchboard #N] b");
    const da = store.insertDispatch({ requestId: a, sessionKey: "s1", sessionName: "app", paneId: "%4", mode: "wait-idle", marker: `[switchboard #${a}]`, createdAt: 1 });
    store.updateDispatch(da.id, { state: "delivering" });
    const db = store.insertDispatch({ requestId: b, sessionKey: "s1", sessionName: "app", paneId: "%4", mode: "wait-idle", marker: `[switchboard #${b}]`, createdAt: 2 });
    dispatcher.resume();
    expect(store.getDispatch(da.id)?.state).toBe("failed");
    await until(() => store.getDispatch(db.id)?.state === "done");
  });
});

describe("summarize", () => {
  it("표·코드로 시작하면 건너뛰고 첫 문단에서 기호를 걷는다", () => {
    expect(summarize("| a | b |\n| - | - |\n\n**드롭다운** 위치를 `fixed`로 고쳤습니다.\n\n자세히…")).toBe("드롭다운 위치를 fixed로 고쳤습니다.");
    expect(summarize("x".repeat(400))).toHaveLength(300);
  });
});
