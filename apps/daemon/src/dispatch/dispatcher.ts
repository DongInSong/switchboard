import type { Dispatch, DispatchMode, Session, SessionSnapshot, WaitReason } from "@switchboard/protocol";
import { assistantReply, type Activity } from "../activity/transcript.ts";
import { sanitizeText } from "../compose.ts";
import { getLang, t, type Key } from "../i18n.ts";
import { ancestry, type ProcStat } from "../registry/proc.ts";
import type { DispatchPatch, Store } from "../store.ts";
import { inputHasPaste, readInputBox } from "./screen.ts";
import type { PaneInfo, TmuxLike } from "./tmux-driver.ts";

/**
 * 승인된 요청을 tmux로 세션 입력칸에 넣는다. 세션별 대기열 하나, 한 번에 하나씩.
 *
 *   queued ──(사전 점검 통과)──▶ delivering ──(제출 확인)──▶ delivered ──(busy)──▶ working ──(idle)──▶ done
 *     │  기다림: busy / waiting / input / unknown-screen / gone             └─ 확인 안 되면 failed (Enter 재전송 안 함)
 *     └─ cancel ▶ cancelled
 *
 * 절대 하지 않는 것: 응답 대기(권한 확인·대화상자) 화면이나 사용자가 치다 만 글 위에 입력하기.
 */

export type DispatcherRegistry = {
  readonly snapshot: SessionSnapshot | null;
  refresh(): Promise<SessionSnapshot>;
  on(event: "change", fn: (s: SessionSnapshot) => void): unknown;
  off(event: "change", fn: (s: SessionSnapshot) => void): unknown;
};

export type DispatcherConfig = {
  /** 붙여넣기 뒤 Enter까지. TUI가 붙여넣기를 처리할 시간. */
  pasteDelayMs: number;
  /** 붙여 넣은 내용이 입력칸에 보이기까지 기다리는 시간. */
  pasteVisibleMs: number;
  /** Enter 뒤 제출 확인까지. */
  verifyTimeoutMs: number;
  /** 확인 단계 폴링 간격. */
  verifyPollMs: number;
  /** 예약 상태에서 다시 점검하는 간격(레지스트리 변경 이벤트가 오면 더 빨리). */
  waitPollMs: number;
  /** 예약 상태 최대 대기. */
  queueTimeoutMs: number;
  /** 세션이 사라진 채로 버티는 시간. */
  goneGraceMs: number;
  /** 작업 추적 최대 시간. */
  workTimeoutMs: number;
  /** VS Code 세션: 사용자가 붙여 넣기를 기다리는 최대 시간. */
  pasteTimeoutMs: number;
};

export const DEFAULT_CONFIG: DispatcherConfig = {
  pasteDelayMs: 150,
  pasteVisibleMs: 1500,
  verifyTimeoutMs: 8000,
  verifyPollMs: 300,
  waitPollMs: 3000,
  queueTimeoutMs: 2 * 60 * 60_000,
  goneGraceMs: 60_000,
  workTimeoutMs: 6 * 60 * 60_000,
  pasteTimeoutMs: 30 * 60_000,
};

export type DispatcherDeps = {
  store: Store;
  registry: DispatcherRegistry;
  tmux: TmuxLike;
  activity: { get(sessionId: string, cwd: string): Promise<Activity | null> };
  readStat(pid: number): Promise<ProcStat | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (d: Dispatch) => void;
  log?: (msg: string) => void;
  config?: Partial<DispatcherConfig>;
  /** VS Code 세션의 탭을 앞으로 띄운다(vscode://…). 프롬프트는 확장이 클립보드에 넣는다. */
  openSession?: (s: Session) => Promise<boolean>;
};

type Preflight = { ok: true; session: Session; pane: PaneInfo } | { ok: false; wait: WaitReason } | { ok: false; fail: string };

const SUMMARY_MAX = 300;
const REPLY_MAX = 64 * 1024;

/** 칩 한 줄용 요약: 첫 문단에서 마크다운 기호를 걷어 낸다. */
export function summarize(reply: string): string {
  const firstBlock = reply.split(/\n\s*\n/).find((b) => b.trim() && !/^\s*(\||```|-{3,})/.test(b)) ?? reply;
  const plain = firstBlock.replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1)}…` : plain;
}

export class Dispatcher {
  readonly #d: DispatcherDeps;
  readonly #c: DispatcherConfig;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #workers = new Map<string, Promise<void>>();
  readonly #tracking = new Set<number>();
  readonly #cancelled = new Set<number>();
  #stopped = false;

  constructor(d: DispatcherDeps) {
    this.#d = d;
    this.#c = { ...DEFAULT_CONFIG, ...d.config };
    this.#now = d.now ?? Date.now;
    this.#sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 승인된 요청을 대기열에 넣는다. */
  enqueue(requestId: number, session: Session, mode: DispatchMode, marker: string): Dispatch {
    const d = this.#d.store.insertDispatch({
      requestId,
      sessionKey: session.key,
      sessionName: session.name,
      paneId: session.tmux?.paneId ?? null,
      mode,
      marker,
      createdAt: this.#now(),
    });
    this.#emit(d);
    this.#kick(session.key);
    return d;
  }

  /** 예약 상태만 취소할 수 있다. 이미 입력한 뒤에는 되돌릴 수 없다. */
  cancel(id: number): Dispatch | null {
    const d = this.#d.store.getDispatch(id);
    if (!d || d.state !== "queued") return d;
    this.#cancelled.add(id);
    return this.#update(id, { state: "cancelled", finishedAt: this.#now(), waitReason: null });
  }

  /** 데몬 재시작 뒤: 예약은 다시 돌리고, 입력 도중이던 것은 실패로, 작업 중이던 것은 계속 추적한다. */
  resume(): void {
    for (const d of this.#d.store.activeDispatches()) {
      if (d.state === "queued") this.#kick(d.sessionKey);
      else if (d.state === "delivering") this.#update(d.id, { state: "failed", error: this.#t(d.requestId, "dsp.restart"), finishedAt: this.#now() });
      else this.#trackInBackground(d.id);
    }
  }

  #trackInBackground(id: number) {
    this.#track(id).catch((e: unknown) => {
      if (!this.#stopped) this.#log(`! track #${id}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  stop(): void {
    this.#stopped = true;
  }

  /** 테스트·종료용: 진행 중인 작업이 모두 끝날 때까지. */
  async idle(): Promise<void> {
    while (this.#workers.size > 0) await Promise.all([...this.#workers.values()]);
  }

  #emit(d: Dispatch) {
    this.#d.onUpdate?.(d);
  }

  #update(id: number, patch: DispatchPatch): Dispatch {
    const d = this.#d.store.updateDispatch(id, patch);
    this.#emit(d);
    return d;
  }

  #log(msg: string) {
    this.#d.log?.(msg);
  }

  /** 칩에 보일 문구는 그 요청의 언어로. */
  #t(requestId: number, key: Key, params?: Record<string, string | number>): string {
    return t(key, params, this.#d.store.getRequest(requestId)?.lang ?? getLang());
  }

  #kick(sessionKey: string) {
    if (this.#workers.has(sessionKey)) return;
    const worker = (async () => {
      try {
        for (let d = this.#d.store.nextQueued(sessionKey); d && !this.#stopped; d = this.#d.store.nextQueued(sessionKey)) {
          await this.#process(d.id);
        }
      } catch (e) {
        if (!this.#stopped) this.#log(`! dispatcher(${sessionKey}): ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.#workers.delete(sessionKey);
      }
    })();
    this.#workers.set(sessionKey, worker);
  }

  /** 레지스트리가 바뀌거나 ms가 지날 때까지 기다린다. */
  #waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#d.registry.off("change", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#d.registry.on("change", done);
    });
  }

  #findSession(key: string, snap: SessionSnapshot | null): Session | undefined {
    return snap?.sessions.find((s) => s.key === key);
  }

  async #preflight(d: Dispatch, snap: SessionSnapshot | null): Promise<Preflight> {
    const s = this.#findSession(d.sessionKey, snap);
    if (!s || s.pid === undefined) return { ok: false, wait: "gone" };
    if (!s.dispatchable || !s.tmux) return { ok: false, fail: this.#t(d.requestId, "dsp.notDispatchable") };
    const stat = await this.#d.readStat(s.pid);
    if (!stat || (s.procStart && stat.startTime !== s.procStart)) return { ok: false, wait: "gone" };
    if (s.status === "waiting") return { ok: false, wait: "waiting" };
    if (s.status === "busy" && d.mode === "wait-idle") return { ok: false, wait: "busy" };
    if (s.status === undefined) return { ok: false, wait: "unknown-screen" };
    const pane = await this.#d.tmux.paneInfo(s.tmux.paneId);
    if (!pane || pane.dead) return { ok: false, wait: "gone" };
    // pane이 정말 이 세션의 것인지 다시 확인(pane 번호 재사용 대비)
    const chain = await ancestry(s.pid, this.#d.readStat);
    if (!chain.some((p) => p.pid === pane.panePid)) return { ok: false, fail: this.#t(d.requestId, "dsp.paneMismatch") };
    if (pane.inMode) return { ok: false, wait: "unknown-screen" };
    const screen = await this.#d.tmux.capture(pane.paneId);
    if (screen === null) return { ok: false, wait: "gone" };
    const box = readInputBox(screen);
    if (box.state === "unknown") return { ok: false, wait: "unknown-screen" };
    if (box.state === "text") return { ok: false, wait: "input" };
    return { ok: true, session: s, pane };
  }

  async #process(id: number): Promise<void> {
    const startedAt = this.#now();
    let goneSince: number | null = null;
    for (;;) {
      if (this.#stopped || this.#cancelled.has(id)) return;
      const d = this.#d.store.getDispatch(id);
      if (!d || d.state !== "queued") return;
      if (this.#now() - startedAt > this.#c.queueTimeoutMs) {
        this.#update(id, { state: "failed", error: this.#t(d.requestId, "dsp.queueTimeout"), finishedAt: this.#now(), waitReason: null });
        return;
      }
      const snap = this.#d.registry.snapshot ?? (await this.#d.registry.refresh());
      const target = this.#findSession(d.sessionKey, snap);
      if (target?.delivery === "vscode") {
        await this.#manual(d, target);
        return;
      }
      const pre = await this.#preflight(d, snap);
      if (pre.ok) {
        await this.#deliver(d, pre.session, pre.pane);
        return;
      }
      if ("fail" in pre) {
        this.#update(id, { state: "failed", error: pre.fail, finishedAt: this.#now(), waitReason: null });
        return;
      }
      if (pre.wait === "gone") {
        goneSince ??= this.#now();
        if (this.#now() - goneSince > this.#c.goneGraceMs) {
          this.#update(id, { state: "failed", error: this.#t(d.requestId, "dsp.gone"), finishedAt: this.#now(), waitReason: null });
          return;
        }
      } else goneSince = null;
      if (d.waitReason !== pre.wait) this.#update(id, { waitReason: pre.wait });
      await this.#waitForChange(this.#c.waitPollMs);
    }
  }

  async #deliver(d: Dispatch, s: Session, pane: PaneInfo): Promise<void> {
    if (this.#cancelled.has(d.id)) return;
    const req = this.#d.store.getRequest(d.requestId);
    if (!req) {
      this.#update(d.id, { state: "failed", error: this.#t(d.requestId, "dsp.noRequest"), finishedAt: this.#now() });
      return;
    }
    const fail = (error: string) => this.#update(d.id, { state: "failed", error, finishedAt: this.#now(), waitReason: null });
    const begunAt = this.#now();
    this.#update(d.id, { state: "delivering", waitReason: null, paneId: pane.paneId });
    this.#log(`#${d.requestId} → ${s.name} (${pane.paneId})`);

    const text = sanitizeText(req.prompt);
    if (!(await this.#d.tmux.paste(pane.paneId, text, `sb-${d.id}`))) return void fail(this.#t(d.requestId, "dsp.pasteFailed"));

    // 붙여 넣은 내용이 입력칸에 보여야 Enter를 누른다. 안 보이면 아무것도 제출하지 않고 멈춘다.
    let visible = false;
    for (const until = this.#now() + this.#c.pasteVisibleMs; this.#now() <= until; ) {
      await this.#sleep(this.#c.pasteDelayMs);
      const screen = await this.#d.tmux.capture(pane.paneId);
      if (screen && inputHasPaste(readInputBox(screen), d.marker)) {
        visible = true;
        break;
      }
    }
    if (!visible) return void fail(this.#t(d.requestId, "dsp.notVisible"));
    if (!(await this.#d.tmux.enter(pane.paneId))) return void fail(this.#t(d.requestId, "dsp.enterFailed"));

    // 제출 확인: 입력칸에서 사라졌거나, 세션이 busy가 되었거나, 대화 기록에 프롬프트가 생겼으면 성공.
    for (const until = this.#now() + this.#c.verifyTimeoutMs; this.#now() <= until; ) {
      await this.#sleep(this.#c.verifyPollMs);
      const [screen, snap, activity] = await Promise.all([
        this.#d.tmux.capture(pane.paneId),
        this.#d.registry.refresh(),
        s.sessionId ? this.#d.activity.get(s.sessionId, s.cwd).catch(() => null) : Promise.resolve(null),
      ]);
      const box = screen ? readInputBox(screen) : null;
      const cleared = box !== null && box.state !== "unknown" && !inputHasPaste(box, d.marker);
      const busy = this.#findSession(s.key, snap)?.status === "busy";
      const recorded = activity?.events.some((e) => e.kind === "prompt" && e.text.includes(d.marker) && e.at >= begunAt - 2000) ?? false;
      if (cleared || busy || recorded) {
        this.#update(d.id, { state: busy ? "working" : "delivered", deliveredAt: this.#now() });
        this.#trackInBackground(d.id);
        return;
      }
    }
    fail(this.#t(d.requestId, "dsp.unverified"));
  }

  /**
   * VS Code 세션: 입력칸에 글을 넣을 공식 통로가 없어서(이미 열린 탭에는 vscode:// 의 prompt가 적용되지 않음, 실측)
   * 탭만 앞으로 띄우고 사용자가 붙여 넣기(클립보드)를 기다린다. 대화 기록에 마커가 나타나면 전달된 것으로 보고 추적한다.
   */
  async #manual(d: Dispatch, s: Session): Promise<void> {
    const fail = (error: string) => this.#update(d.id, { state: "failed", error, finishedAt: this.#now(), waitReason: null });
    if (!s.sessionId) return void fail(this.#t(d.requestId, "dsp.noSessionId"));
    const begunAt = this.#now();
    if (d.waitReason !== "paste") {
      // 데몬 재시작으로 다시 들어온 경우에는 창을 또 띄우지 않는다
      this.#update(d.id, { waitReason: "paste" });
      this.#log(t("dsp.log.vscodeWait", { id: d.requestId, name: s.name }));
      void this.#d.openSession?.(s).then((ok) => {
        if (!ok) this.#log(t("dsp.log.openFailed", { id: d.requestId }));
      });
    }
    let goneSince: number | null = null;
    while (!this.#stopped) {
      if (this.#cancelled.has(d.id)) return;
      const cur = this.#d.store.getDispatch(d.id);
      if (!cur || cur.state !== "queued") return;
      if (this.#now() - (cur.createdAt ?? begunAt) > this.#c.pasteTimeoutMs) return void fail(this.#t(d.requestId, "dsp.pasteTimeout"));
      const activity = await this.#d.activity.get(s.sessionId, s.cwd).catch(() => null);
      if (activity?.events.some((e) => e.kind === "prompt" && e.text.includes(d.marker) && e.at >= cur.createdAt - 2000)) {
        const snap = await this.#d.registry.refresh().catch(() => this.#d.registry.snapshot);
        const busy = this.#findSession(s.key, snap)?.status === "busy";
        this.#update(d.id, { state: busy ? "working" : "delivered", deliveredAt: this.#now(), waitReason: null });
        this.#log(t("dsp.log.pasted", { id: d.requestId }));
        this.#trackInBackground(d.id);
        return;
      }
      if (!this.#findSession(s.key, this.#d.registry.snapshot)) {
        goneSince ??= this.#now();
        if (this.#now() - goneSince > this.#c.goneGraceMs) return void fail(this.#t(d.requestId, "dsp.vscodeClosed"));
      } else goneSince = null;
      await this.#waitForChange(Math.min(this.#c.waitPollMs, 1500));
    }
  }

  /** 전달 뒤 작업이 끝날 때까지 지켜본다(busy → idle). */
  async #track(id: number): Promise<void> {
    if (this.#tracking.has(id)) return;
    this.#tracking.add(id);
    try {
      const start = this.#now();
      let sawBusy = this.#d.store.getDispatch(id)?.state === "working";
      let goneSince: number | null = null;
      while (!this.#stopped) {
        const d = this.#d.store.getDispatch(id);
        if (!d || (d.state !== "delivered" && d.state !== "working")) return;
        if (this.#now() - start > this.#c.workTimeoutMs) {
          this.#update(id, { error: this.#t(d.requestId, "dsp.trackTimeout"), finishedAt: this.#now() });
          return;
        }
        const snap = this.#d.registry.snapshot ?? (await this.#d.registry.refresh());
        const s = this.#findSession(d.sessionKey, snap);
        if (!s) {
          goneSince ??= this.#now();
          if (this.#now() - goneSince > this.#c.goneGraceMs) {
            this.#update(id, { state: "failed", error: this.#t(d.requestId, "dsp.endedWhileWorking"), finishedAt: this.#now() });
            return;
          }
        } else {
          goneSince = null;
          if (s.status === "busy" || s.status === "waiting") {
            sawBusy = true;
            if (d.state !== "working") this.#update(id, { state: "working" });
          } else if (s.status === "idle" && (sawBusy || this.#now() - (d.deliveredAt ?? start) > 5000)) {
            const activity = s.sessionId ? await this.#d.activity.get(s.sessionId, s.cwd).catch(() => null) : null;
            const reply = activity ? assistantReply(activity, d.marker) : undefined;
            this.#update(id, {
              state: "done",
              finishedAt: this.#now(),
              summary: reply ? summarize(reply) : null,
              reply: reply ? reply.slice(0, REPLY_MAX) : null,
            });
            this.#log(t("dsp.log.done", { id: d.requestId }));
            return;
          }
        }
        await this.#waitForChange(this.#c.waitPollMs);
      }
    } finally {
      this.#tracking.delete(id);
    }
  }
}
