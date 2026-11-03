import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Dispatch, Recommendation, Rect, Session, SessionSnapshot } from "@switchboard/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { send } from "../messages.ts";
import { t } from "../i18n.ts";
import { altDigit, altLabel, isAlt, sendLabel } from "../keys.ts";
import { copyText, pasteKey, dispatchLabel, elapsed, isFinal, orderedSessions, pasteHint, primaryLabel, projectName, reasonLabel, sourceShort, statusOf, surfaceTag, waitLabel } from "../ui/labels.ts";
import type { DraftSummary } from "../drafts.ts";
import { Markdown } from "../ui/Markdown.tsx";
import { insideViewport, placeAtPoint } from "./place.ts";
import { ThumbCanvas } from "../ui/ThumbCanvas.tsx";
import { closePopover, loadDraft, raisePopover, saveDraft, updateChip, updatePopover, useStore, type Chip, type Composing, type Link, type Store } from "./store.ts";

/** 선택이 어디로 가는지(새 팝업이 아니면): 이 페이지 팝업에 덧붙이기 / 칩의 이어서 쓰기에 덧붙이기. */
export type PickTarget = { kind: "popover"; id: string } | { kind: "chip"; id: number };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/** 연계 대상 한 줄: `+N 이름 [페이지] 파일:줄 [썸네일] ✕` */
function LinkRow({ l, n, openShot, setOpenShot, onRemove, hostUrl }: { l: Link; n: number; openShot: string | null; setOpenShot(v: string | null): void; onRemove(): void; hostUrl: string }) {
  const ls = sourceShort(l.source);
  const otherPage = l.page && l.page.url !== hostUrl;
  return (
    <div>
      <div className="sb-row sb-link">
        <span className="sb-link-mark" aria-hidden>
          +{n}
        </span>
        <span className="sb-name">{l.name}</span>
        {otherPage && (
          <span className="sb-page" title={`${l.page!.title}\n${l.page!.url}`}>
            {pathOf(l.page!.url)}
          </span>
        )}
        <span className="sb-src" title={ls?.full}>
          {ls?.short ?? ""}
        </span>
        {l.captureError ? (
          <span className="sb-error" title={l.captureError}>
            {t("captureFailed")}
          </span>
        ) : !l.captureId ? (
          <span className="sb-glyph sb-spin tone-busy" aria-hidden />
        ) : null}
        {l.thumbnail && (
          <button type="button" className="sb-thumb" aria-label={t("target.shot", { n })} aria-pressed={openShot === l.id} onClick={() => setOpenShot(openShot === l.id ? null : l.id)}>
            <ThumbCanvas thumb={l.thumbnail} maxW={42} maxH={26} maxScale={4} />
          </button>
        )}
        <button type="button" className="sb-x" aria-label={t("target.remove", { n })} onClick={onRemove}>
          ✕
        </button>
      </div>
      {openShot === l.id && l.thumbnail && (
        <div className="sb-shot">
          <ThumbCanvas thumb={l.thumbnail} maxW={350} maxH={220} maxScale={2} />
        </div>
      )}
    </div>
  );
}

type Conn = "loading" | "ok" | "unpaired" | "disconnected";

const lastKey = (origin: string) => `sb:last:${origin}`;

async function rememberedSession(origin: string): Promise<string | undefined> {
  const v = (await browser.storage.local.get(lastKey(origin)))[lastKey(origin)];
  return typeof v === "string" ? v : undefined;
}

/** 팝업과 화면 가장자리 사이 여백. */
const POP_PAD = 8;

function virtualRef(r: Rect) {
  return {
    getBoundingClientRect: () => ({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height }),
  };
}

function useSessions(active: boolean) {
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [conn, setConn] = useState<Conn>("loading");
  const load = useCallback(async (fresh = false) => {
    const res = await send({ type: "daemon/sessions", fresh });
    if (res.ok) {
      setSnap(res.data);
      setConn("ok");
    } else setConn(res.error === "unauthorized" ? "unpaired" : "disconnected");
  }, []);
  useEffect(() => {
    if (!active) return;
    void load(true); // 팝업을 열 때는 최신 상태로
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [active, load]);
  return { snap, conn, reload: load };
}

/** ▸▸ 상태줄 머리. Claude Code 하단 모드 표시(⏵⏵)를 어디서나 그려지는 기호로. */
const Mode = () => (
  <span className="sb-mode" aria-hidden>
    ▸▸
  </span>
);

function Pairing({ onDone }: { onDone(): void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const res = await send({ type: "daemon/pair", code });
    if (res.ok) onDone();
    else setError(res.error === "expired" || res.error === "no-code" ? t("pair.expired") : res.error === "locked" ? t("pair.locked") : t("pair.wrong"));
  };
  return (
    <div className="sb-pair" title={t("pair.hint")}>
      <Mode />
      <span>{t("pair.title")}</span>
      <input
        className="sb-code"
        inputMode="numeric"
        placeholder="000 000"
        value={code}
        maxLength={7}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button className="sb-btn" disabled={code.replace(/\D/g, "").length !== 6} onClick={() => void submit()}>
        {t("ok")}
      </button>
      {error && <span className="sb-error">{error}</span>}
    </div>
  );
}

/** Claude Code 선택 목록 한 줄: `❯ 1. 이름  상태  근거 · 근거` */
function SessionRow({ s, selected, index, tags, onPick }: { s: Session; selected: boolean; index?: number; tags: string[]; onPick(): void }) {
  const st = statusOf(s);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`sb-srow${selected ? " is-selected" : ""}`}
      disabled={!s.dispatchable}
      onClick={onPick}
      title={s.title ? `${s.title}\n${s.cwd}` : s.cwd}
    >
      <span className="sb-cursor">{selected ? "❯" : ""}</span>
      <span className="sb-idx">{index !== undefined ? `${index + 1}.` : ""}</span>
      <span className="sb-sname">{s.name}</span>
      <span className={`sb-status tone-${st.tone}`}>{st.label}</span>
      {surfaceTag(s) && <span className="sb-surface">{surfaceTag(s)}</span>}
      <span className="sb-meta">{tags.length ? tags.join(" · ") : projectName(s.git?.root ?? s.cwd)}</span>
    </button>
  );
}

type SessionsState = ReturnType<typeof useSessions>;

function Popover({
  store,
  c,
  sessionsState,
  onAttach,
  attaching,
  focusReq,
}: {
  store: Store;
  c: Composing;
  sessionsState: SessionsState;
  onAttach(): void;
  attaching: boolean;
  focusReq: { id: string; n: number } | null;
}) {
  const origin = useMemo(() => {
    try {
      return new URL(c.draft.url).origin;
    } catch {
      return "";
    }
  }, [c.draft.url]);
  const { snap, conn, reload } = sessionsState;
  const [text, setText] = useState(() => c.text || loadDraft(c.key));
  const [recs, setRecs] = useState<Recommendation[]>(c.recommendations);
  const [selectedKey, setSelectedKey] = useState<string | null>(c.selectedKey);
  const [remembered, setRemembered] = useState<string | undefined>(undefined);
  const [userPicked, setUserPicked] = useState(c.userPicked);
  // 쓰던 내용·고른 세션을 store에 올려 둔다(백그라운드가 보관 → 새로고침·이동 뒤 복원)
  useEffect(() => {
    const t = setTimeout(() => updatePopover(store, c.id, { text }), 250);
    return () => clearTimeout(t);
  }, [text, store, c.id]);
  useEffect(() => updatePopover(store, c.id, { selectedKey, userPicked }), [selectedKey, userPicked, store, c.id]);
  // 연계: 이 요청을 다른 요청(이 페이지의 다른 팝업, 다른 페이지·탭의 요청)에 참고 대상으로 붙이기
  const [linkOpen, setLinkOpen] = useState(false);
  const [remoteOthers, setRemoteOthers] = useState<DraftSummary[]>([]);
  useEffect(() => {
    const load = async () => {
      const res = await send({ type: "drafts/others", url: c.draft.url });
      if (res.ok) setRemoteOthers(res.data);
    };
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [c.draft.url]);
  // 세션 목록은 사용자가 열 때만 열린다(자동 선택·3초 갱신은 목록을 건드리지 않는다).
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 크게 보는 스크린샷: "main"(대상 1) 또는 연계 대상 id. */
  const [openShot, setOpenShot] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [manual, setManual] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const sessions = useMemo(() => orderedSessions(snap), [snap]);
  const byKey = useMemo(() => new Map(sessions.map((s) => [s.key, s])), [sessions]);
  const recSessions = recs.map((r) => byKey.get(r.sessionKey)).filter((s): s is Session => !!s && s.dispatchable);
  const rest = sessions.filter((s) => !recSessions.includes(s));
  const quick = recSessions.length ? recSessions : sessions.filter((s) => s.dispatchable);
  const selected = selectedKey ? byKey.get(selectedKey) : undefined;
  const src = sourceShort(c.source);

  useEffect(() => setRecs(c.recommendations), [c.recommendations]);

  useEffect(() => {
    void rememberedSession(origin).then(setRemembered);
  }, [origin]);

  // 입력이 바뀌면 주제 신호를 반영해 추천을 다시 받는다.
  useEffect(() => {
    if (!c.captureId || !text.trim()) return;
    const t = setTimeout(async () => {
      const res = await send({ type: "daemon/recommend", captureId: c.captureId!, text });
      if (res.ok) setRecs(res.data.recommendations);
    }, 600);
    return () => clearTimeout(t);
  }, [text, c.captureId]);

  // 기본 선택: 신뢰도가 충분한 추천 1위 → 이 사이트에서 마지막으로 고른 세션 → 없으면 비워 둔다(목록은 사용자가 열 때만).
  // 사용자가 직접 고른 뒤에는 늦게 온 추천이 덮어쓰지 않는다.
  useEffect(() => {
    if (userPicked || !snap) return;
    const top = recs[0];
    const topSession = top && top.confidence !== "low" ? byKey.get(top.sessionKey) : undefined;
    const prev = remembered ? byKey.get(remembered) : undefined;
    const pick = topSession?.dispatchable ? topSession : prev?.dispatchable ? prev : undefined;
    if (pick) {
      setSelectedKey(pick.key);
    } else if (c.captureId) {
      setSelectedKey(null);
    }
  }, [snap, recs, remembered, userPicked, c.captureId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 선택 직후 클릭 없이 바로 칠 수 있게. 위치가 정해져 보이는 순간 포커스(숨김 상태에서는 포커스가 안 들어간다).
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    textRef.current?.focus({ preventScroll: true });
  }, [pos]);
  // 연계 선택이 끝나면 이 팝업으로 포커스를 돌려받는다.
  useEffect(() => {
    if (focusReq?.id === c.id) textRef.current?.focus({ preventScroll: true });
  }, [focusReq, c.id]);

  // 위치: 선택 영역 옆. 옆 어디에도 다 들어가지 않으면(큰 영역) 선택을 끝낸 포인터 위치에 붙여 영역과 겹치게 둔다.
  // 사용자가 끌어 옮기면 그대로 둔다.
  const pointX = c.point?.x;
  const pointY = c.point?.y;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || manual) return;
    let alive = true;
    const update = async () => {
      const side = await computePosition(virtualRef(c.rect), el, {
        strategy: "fixed",
        placement: "right-start",
        // 근처에 이미 떠 있는 팝업이 있으면 그만큼 비켜서.
        // flip은 옆 방향(가로·세로 중 붙는 쪽)만 따지고, 다른 축은 shift가 화면 안으로 민다.
        middleware: [
          offset({ mainAxis: 10 + c.cascade * 16, crossAxis: c.cascade * 32 }),
          flip({ crossAxis: false, fallbackPlacements: ["bottom-start", "left-start", "top-start"] }),
          shift({ padding: POP_PAD }),
        ],
      });
      if (!alive) return;
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const vp = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
      if (insideViewport({ x: side.x, y: side.y, ...size }, vp, POP_PAD)) {
        setPos({ x: side.x, y: side.y });
        return;
      }
      // 예전 초안에는 포인터 위치가 없다: 영역 오른쪽 아래 끝(보통 드래그를 끝낸 곳)
      const point = pointX !== undefined && pointY !== undefined ? { x: pointX, y: pointY } : { x: c.rect.x + c.rect.width, y: c.rect.y + c.rect.height };
      setPos(placeAtPoint(point, size, vp, { pad: POP_PAD, gap: 12 + c.cascade * 16 }));
    };
    void update();
    const ro = new ResizeObserver(() => void update());
    ro.observe(el);
    const onResize = () => void update();
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [c.rect, c.cascade, pointX, pointY, manual]);

  const extraIds = c.links.flatMap((l) => (l.captureId ? [l.captureId] : []));
  const extraKey = extraIds.join(",");
  const linksPending = c.links.some((l) => !l.captureId && !l.captureError);

  useEffect(() => {
    if (!previewOpen || !c.captureId) return;
    const t = setTimeout(async () => {
      const res = await send({
        type: "daemon/preview",
        captureId: c.captureId!,
        extraCaptureIds: extraKey ? extraKey.split(",") : [],
        text,
        ...(selectedKey ? { sessionKey: selectedKey } : {}),
      });
      setPreview(res.ok ? res.data.prompt : "");
    }, 250);
    return () => clearTimeout(t);
  }, [previewOpen, text, c.captureId, selectedKey, extraKey]);

  const removeLink = (id: string) => store.set((s) => ({ popovers: s.popovers.map((p) => (p.id === c.id ? { ...p, links: p.links.filter((l) => l.id !== id) } : p)) }));

  const localOthers = store.get().popovers.filter((p) => p.id !== c.id);
  // 이 탭의 다른 주소(SPA) 팝업은 store에도 있으므로 한 번만
  const remote = remoteOthers.filter((d) => !store.get().popovers.some((p) => p.id === d.id));
  const hasOthers = localOthers.length > 0 || remote.length > 0;
  /** 이 요청(대상 1 + 덧붙인 것)을 연계 대상들로 바꾼다. 다른 페이지로 가면 페이지 정보를 단다. */
  const asLinks = (): Link[] => [
    { id: `${c.id}-m`, name: c.name, source: c.source, thumbnail: c.thumbnail, captureId: c.captureId, captureError: null, page: { url: c.draft.url, title: c.draft.title } },
    ...c.links.map((l) => (l.page ? l : { ...l, page: { url: c.draft.url, title: c.draft.title } })),
  ];
  const linkInto = async (targetId: string, name: string, local: boolean) => {
    if (!c.captureId || linksPending) return;
    if (local) {
      store.set((s) => ({ popovers: s.popovers.filter((p) => p.id !== c.id).map((p) => (p.id === targetId ? { ...p, links: [...p.links, ...asLinks()] } : p)) }));
    } else {
      const res = await send({ type: "drafts/link", targetId, links: asLinks() });
      if (!res.ok) {
        setError(t("link.closed"));
        return;
      }
      closePopover(store, c.id);
    }
    saveDraft(c.key, "");
    store.set({ toast: { text: t("link.attached", { name }), n: Date.now() } });
  };

  const close = () => {
    saveDraft(c.key, text);
    closePopover(store, c.id);
  };

  const pick = (s: Session) => {
    if (!s.dispatchable) return;
    setSelectedKey(s.key);
    setUserPicked(true);
    setListOpen(false);
    textRef.current?.focus();
  };

  const canSend = conn === "ok" && !!c.captureId && !linksPending && !!selected?.dispatchable && text.trim().length > 0 && !sending;

  const submit = async () => {
    if (!canSend || !selected || !c.captureId) return;
    setSending(true);
    setError(null);
    const res = await send({ type: "daemon/request", captureId: c.captureId, extraCaptureIds: extraIds, text, sessionKey: selected.key });
    setSending(false);
    if (!res.ok) {
      setError(res.error === "session-gone" ? t("err.sessionGone") : res.error === "not-dispatchable" ? t("err.notDispatchable") : t("err.failed"));
      return;
    }
    // VS Code 세션: 입력칸에 넣을 공식 통로가 없어 프롬프트를 복사해 두고, 데몬이 그 탭을 띄운다
    if (selected.delivery === "vscode") {
      const copied = await copyText(res.data.prompt);
      store.set({ toast: { text: copied ? pasteHint() : t("copy.failedRetry"), n: Date.now() } });
    }
    await browser.storage.local.set({ [lastKey(origin)]: selected.key });
    saveDraft(c.key, "");
    const chip: Chip = { id: res.data.id, sessionName: selected.name, text, prompt: res.data.prompt, expanded: false, dispatch: res.data.dispatch, followText: "", followLinks: [] };
    store.set((s) => ({ popovers: s.popovers.filter((p) => p.id !== c.id), chips: [...s.chips, chip] }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (listOpen && selected) setListOpen(false);
      else close();
    } else if ((altDigit(e) ?? 9) <= 3) {
      e.preventDefault();
      const s = quick[altDigit(e)! - 1];
      if (s) pick(s);
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      setListOpen((v) => !v);
    } else if (isAlt(e, "p")) {
      e.preventDefault();
      setPreviewOpen((v) => !v);
    } else if (isAlt(e, "a")) {
      e.preventDefault();
      onAttach();
    } else if (isAlt(e, "l") && hasOthers) {
      e.preventDefault();
      setLinkOpen((v) => !v);
    }
  };

  // 머리줄 끌어 옮기기
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onHeaderDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button") || !pos) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setManual(true);
    setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
  };
  const onHeaderUp = () => {
    drag.current = null;
  };

  const name =
    c.mode === "region"
      ? t("region", { w: Math.round(c.rect.width), h: Math.round(c.rect.height), name: c.name })
      : c.count > 1
        ? t("elements", { n: c.count, name: c.name })
        : c.name;
  const match = (s: Session) => !filter || `${s.name} ${s.cwd} ${s.title ?? ""}`.toLowerCase().includes(filter.toLowerCase());
  const tagsFor = (s: Session) => {
    const rec = recs.find((r) => r.sessionKey === s.key);
    const tags = rec ? rec.reasons.map((r) => reasonLabel(r)) : [];
    if (!rec && s.key === remembered) tags.push(reasonLabel("previous-choice"));
    return tags;
  };
  const shownRecs = recSessions.filter(match);
  const shownRest = rest.filter(match);

  return (
    <div
      ref={boxRef}
      className={`sb-pop${attaching ? " is-attaching" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-label="Switchboard"
      style={pos ? { transform: `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`, zIndex: c.z } : { opacity: 0, pointerEvents: "none", zIndex: c.z }}
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => raisePopover(store, c.id)}
      onFocusCapture={() => raisePopover(store, c.id)}
    >
      <div className="sb-row sb-head" onPointerDown={onHeaderDown} onPointerMove={onHeaderMove} onPointerUp={onHeaderUp}>
        <span className="sb-brand" aria-hidden>
          ✻
        </span>
        <span className="sb-name" title={c.draft.selection.primary.selector}>
          {name}
        </span>
        {src ? (
          <span className="sb-src" title={src.full}>
            {src.short}
          </span>
        ) : (
          <span className="sb-src" />
        )}
        {c.captureError && (
          <span className="sb-error" title={c.captureError}>
            {t("captureFailed")}
          </span>
        )}
        {c.thumbnail && (
          <button
            type="button"
            className="sb-thumb"
            aria-label={t("screenshot")}
            aria-pressed={openShot === "main"}
            title={t("screenshot.size", { w: c.thumbnail.sourceWidth, h: c.thumbnail.sourceHeight })}
            onClick={() => setOpenShot((v) => (v === "main" ? null : "main"))}
          >
            <ThumbCanvas thumb={c.thumbnail} maxW={42} maxH={26} maxScale={4} />
          </button>
        )}
        <button type="button" className="sb-x" aria-label={t("close")} title="esc" onClick={close}>
          ✕
        </button>
      </div>
      {/* 머리줄과 아래 단축키 줄 사이: 팝업이 화면보다 길어지면 여기만 스크롤 */}
      <div className="sb-body">
        {openShot === "main" && c.thumbnail && (
          <div className="sb-shot">
            <ThumbCanvas thumb={c.thumbnail} maxW={350} maxH={220} maxScale={2} />
          </div>
        )}
        {c.links.map((l, i) => (
          <LinkRow key={l.id} l={l} n={i + 2} openShot={openShot} setOpenShot={setOpenShot} onRemove={() => removeLink(l.id)} hostUrl={c.draft.url} />
        ))}
        <div className="sb-rule" />
        <div className="sb-row sb-input">
          <span className="sb-prompt" aria-hidden>
            ❯
          </span>
          <textarea
            ref={textRef}
            className="sb-text"
            placeholder={t("placeholder.request")}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
            }}
          />
        </div>
        <div className="sb-rule" />
        <div className="sb-session">
          {conn === "unpaired" ? (
            <Pairing onDone={() => void reload()} />
          ) : conn === "disconnected" ? (
            <div className="sb-row" title="switchboard start">
              <Mode />
              <span className="tone-fail">{t("conn.lost")}</span>
              <button type="button" className="sb-btn" onClick={() => void reload()}>
                {t("retry")}
              </button>
            </div>
          ) : conn === "loading" ? (
            <div className="sb-row sb-muted">
              <Mode />…
            </div>
          ) : sessions.length === 0 ? (
            <div className="sb-row sb-muted">
              <Mode />
              {t("sessions.none")}
            </div>
          ) : (
            <>
              <button type="button" className="sb-current" aria-haspopup="listbox" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)} title={altLabel("↓")}>
                <Mode />
                {selected ? (
                  <>
                    <span className="sb-sname">{selected.name}</span>
                    <span className={`sb-status tone-${statusOf(selected).tone}`}>{statusOf(selected).label}</span>
                    {surfaceTag(selected) && <span className="sb-surface">{surfaceTag(selected)}</span>}
                    {tagsFor(selected).length > 0 && <span className="sb-meta">{tagsFor(selected).join(" · ")}</span>}
                  </>
                ) : (
                  <span className="sb-muted">{c.captureId ? t("session") : "…"}</span>
                )}
                <span className="sb-chev">{listOpen ? "▴" : "▾"}</span>
              </button>
              {listOpen && (
                <div className="sb-list" role="listbox">
                  {sessions.length > 6 && <input className="sb-filter" placeholder={t("filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />}
                  {shownRecs.length > 0 && <div className="sb-group">{t("group.suggested")}</div>}
                  {shownRecs.map((s) => (
                    <SessionRow key={s.key} s={s} selected={s.key === selectedKey} index={recSessions.indexOf(s)} tags={tagsFor(s)} onPick={() => pick(s)} />
                  ))}
                  {shownRest.length > 0 && <div className="sb-group">{t("group.all")}</div>}
                  {shownRest.map((s) => {
                    const qi = recSessions.length ? -1 : quick.indexOf(s);
                    return <SessionRow key={s.key} s={s} selected={s.key === selectedKey} index={qi >= 0 && qi < 3 ? qi : undefined} tags={tagsFor(s)} onPick={() => pick(s)} />;
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {previewOpen && <pre className="sb-preview">{c.captureId ? preview || "…" : "…"}</pre>}
        {linkOpen && (
          <div className="sb-list sb-linklist" role="listbox">
            <div className="sb-group">{t("linkInto.title")}</div>
            {localOthers.map((p) => (
              <button key={p.id} type="button" className="sb-srow" onClick={() => void linkInto(p.id, p.name, true)} disabled={!c.captureId || linksPending}>
                <span className="sb-cursor" />
                <span className="sb-sname">{p.name}</span>
                <span className="sb-meta">{p.text ? p.text.split("\n")[0] : t("thisPage")}</span>
              </button>
            ))}
            {remote.map((d) => (
              <button key={d.id} type="button" className="sb-srow" onClick={() => void linkInto(d.id, d.name, false)} disabled={!c.captureId || linksPending} title={`${d.title}\n${d.url}`}>
                <span className="sb-cursor" />
                <span className="sb-sname">{d.name}</span>
                <span className="sb-status tone-off">{pathOf(d.url)}</span>
                <span className="sb-meta">{d.text ? d.text.split("\n")[0] : d.sameTab ? t("thisTab") : t("otherTab")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sb-keys">
        <button type="button" className="sb-key" onClick={onAttach} title={t("key.add.title")}>
          <kbd>{altLabel("a")}</kbd> {t("key.add")}
        </button>
        <span className="sb-sep">·</span>
        {hasOthers && (
          <>
            <button type="button" className="sb-key" aria-pressed={linkOpen} onClick={() => setLinkOpen((v) => !v)} title={t("key.link.title")}>
              <kbd>{altLabel("l")}</kbd> {t("key.link")}
            </button>
            <span className="sb-sep">·</span>
          </>
        )}
        <button type="button" className="sb-key" aria-pressed={previewOpen} onClick={() => setPreviewOpen((v) => !v)}>
          <kbd>{altLabel("p")}</kbd> {t("key.preview")}
        </button>
        {error && <span className="sb-error">{error}</span>}
        <button type="button" className="sb-key sb-send" disabled={!canSend} onClick={() => void submit()} title={selected?.delivery === "vscode" ? t("send.vscode.title", { paste: pasteKey() }) : undefined}>
          {sending || (!c.captureId && !c.captureError) ? "…" : primaryLabel(selected)} <kbd>{sendLabel()}</kbd>
        </button>
      </div>
    </div>
  );
}

/** 상태 기호: 진행 중 ✻ 스피너, 예약 ◌, 결과 ●(색으로 성공·실패). */
function Glyph({ d }: { d: Dispatch | null }) {
  if (d && (d.state === "delivering" || d.state === "delivered" || d.state === "working" || (d.state === "queued" && !d.waitReason))) {
    return <span className="sb-glyph sb-spin tone-busy" aria-hidden />;
  }
  if (d?.state === "queued") {
    return (
      <span className="sb-glyph tone-waiting" aria-hidden>
        ◌
      </span>
    );
  }
  const tone = d?.state === "done" ? "ok" : d?.state === "failed" ? "fail" : "off";
  return (
    <span className={`sb-glyph tone-${tone}`} aria-hidden>
      ●
    </span>
  );
}

/** 보낸 요청의 진행 상황. 끝나지 않은 칩만 0.7초마다 데몬에 묻는다(localhost라 가볍다). */
function useChipPolling(store: Store, chips: Chip[]) {
  const active = chips.filter((c) => !isFinal(c.dispatch)).map((c) => c.id);
  const key = active.join(",");
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",").map(Number);
    const t = setInterval(async () => {
      for (const id of ids) {
        const res = await send({ type: "daemon/request-get", id });
        if (res.ok) store.set((s) => ({ chips: s.chips.map((c) => (c.id === id ? { ...c, dispatch: res.data.dispatch } : c)) }));
      }
    }, 700);
    return () => clearInterval(t);
  }, [key, store]);
}

function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function chipTime(c: Chip): string {
  const d = c.dispatch;
  if (!d) return "";
  return elapsed((d.finishedAt ?? Date.now()) - d.createdAt);
}

/** Claude Code 도구 결과 줄: `└ 내용` */
function Out({ text, tone }: { text: string; tone?: "dim" | "err" }) {
  return (
    <div className="sb-out">
      <span className="sb-out-mark" aria-hidden>
        └
      </span>
      <span className={`sb-out-text${tone ? ` is-${tone}` : ""}`}>{text}</span>
    </div>
  );
}

/** 완료 로그의 전체 답변. 칩에 없으면(되살린 칩 등) 상세를 한 번 받아 온다. */
function useReply(c: Chip, store: Store): string | null {
  const d = c.dispatch;
  const need = c.expanded && d?.state === "done" && d.reply === undefined;
  useEffect(() => {
    if (!need) return;
    void send({ type: "daemon/request-get", id: c.id }).then((res) => {
      if (res.ok && res.data.dispatch) updateChip(store, c.id, { dispatch: res.data.dispatch });
    });
  }, [need, c.id, store]);
  return d?.reply ?? null;
}

function ChipCard({
  c,
  store,
  onAttach,
  focusReq,
}: {
  c: Chip;
  store: Store;
  onAttach(): void;
  focusReq: { id: string; n: number } | null;
}) {
  const d = c.dispatch;
  const st = dispatchLabel(d);
  const wait = d?.state === "queued" && d.waitReason ? waitLabel(d.waitReason) : undefined;
  const reply = useReply(c, store);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openShot, setOpenShot] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toggle = () => updateChip(store, c.id, { expanded: !c.expanded });
  const remove = () => store.set((s) => ({ chips: s.chips.filter((x) => x.id !== c.id) }));
  const cancel = async () => {
    if (!d) return;
    const res = await send({ type: "daemon/cancel", dispatchId: d.id });
    if (res.ok) updateChip(store, c.id, { dispatch: res.data });
  };
  useEffect(() => {
    if (focusReq?.id === `chip:${c.id}`) textRef.current?.focus({ preventScroll: true });
  }, [focusReq, c.id]);

  const pending = c.followLinks.some((l) => !l.captureId && !l.captureError);
  const canFollow = !!d && c.followText.trim().length > 0 && !pending && !sending;
  const follow = async () => {
    if (!canFollow) return;
    setSending(true);
    setError(null);
    const [res, snap] = await Promise.all([
      send({ type: "daemon/followup", id: c.id, text: c.followText, extraCaptureIds: c.followLinks.flatMap((l) => (l.captureId ? [l.captureId] : [])) }),
      send({ type: "daemon/sessions" }),
    ]);
    setSending(false);
    if (!res.ok) {
      setError(res.error === "session-gone" ? t("err.sessionGone") : res.error === "not-dispatchable" ? t("err.notDispatchable") : t("err.failed"));
      return;
    }
    if (snap.ok && snap.data.sessions.find((s) => s.key === res.data.dispatch?.sessionKey)?.delivery === "vscode") {
      const copied = await copyText(res.data.prompt);
      store.set({ toast: { text: copied ? pasteHint() : t("copy.failedRetry"), n: Date.now() } });
    }
    const next: Chip = { id: res.data.id, sessionName: c.sessionName, text: c.followText, prompt: res.data.prompt, expanded: false, dispatch: res.data.dispatch, followText: "", followLinks: [] };
    store.set((s) => ({ chips: [...s.chips.map((x) => (x.id === c.id ? { ...x, expanded: false, followText: "", followLinks: [] } : x)), next] }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void follow();
    } else if (isAlt(e, "a")) {
      e.preventDefault();
      onAttach();
    } else if (e.key === "Escape") {
      e.preventDefault();
      updateChip(store, c.id, { expanded: false });
    }
  };

  const head = (
    <>
      <Glyph d={d} />
      <span className="sb-num">#{c.id}</span>
      <span className="sb-sname">{c.sessionName}</span>
      <span className={`sb-status tone-${st.tone}`} title={wait}>
        {st.label}
      </span>
      <span className="sb-time">{chipTime(c)}</span>
    </>
  );
  if (!c.expanded) {
    return (
      <button type="button" className="sb-chip" onClick={toggle} title={wait ?? d?.error ?? undefined}>
        {head}
      </button>
    );
  }
  return (
    <div className="sb-chip is-open" onKeyDown={onKeyDown}>
      <div className="sb-chip-head" onClick={toggle}>
        {head}
      </div>
      <Out text={c.text} tone="dim" />
      {reply ? (
        <div className="sb-reply">
          <Markdown text={reply} />
        </div>
      ) : (
        d?.summary && <Out text={d.summary} />
      )}
      {d?.error && <Out text={d.error} tone="err" />}
      {wait && <Out text={wait} tone="dim" />}
      {d && (
        <>
          {c.followLinks.map((l, i) => (
            <LinkRow
              key={l.id}
              l={l}
              n={i + 1}
              openShot={openShot}
              setOpenShot={setOpenShot}
              hostUrl={location.href}
              onRemove={() => updateChip(store, c.id, (x) => ({ followLinks: x.followLinks.filter((y) => y.id !== l.id) }))}
            />
          ))}
          <div className="sb-rule" />
          <div className="sb-row sb-input">
            <span className="sb-prompt" aria-hidden>
              ❯
            </span>
            <textarea
              ref={textRef}
              className="sb-text sb-follow"
              placeholder={t("placeholder.follow")}
              rows={1}
              value={c.followText}
              onChange={(e) => updateChip(store, c.id, { followText: e.target.value })}
            />
          </div>
        </>
      )}
      <div className="sb-keys">
        {d && (
          <>
            <button type="button" className="sb-key" onClick={onAttach} title={t("key.addFollow.title")}>
              <kbd>{altLabel("a")}</kbd> {t("key.add")}
            </button>
            <span className="sb-sep">·</span>
          </>
        )}
        {d?.state === "queued" && d.waitReason === "paste" && (
          <>
            <button
              type="button"
              className="sb-key"
              title={pasteHint()}
              onClick={() => void copyText(c.prompt).then((ok) => store.set({ toast: { text: ok ? pasteHint() : t("copy.failed"), n: Date.now() } }))}
            >
              {t("copy")}
            </button>
            <span className="sb-sep">·</span>
          </>
        )}
        {d?.state === "queued" && (
          <>
            <button type="button" className="sb-key" onClick={() => void cancel()}>
              {t("cancel")}
            </button>
            <span className="sb-sep">·</span>
          </>
        )}
        {d?.state === "done" && (
          <>
            <button type="button" className="sb-key" onClick={() => location.reload()}>
              {t("reload")}
            </button>
            <span className="sb-sep">·</span>
          </>
        )}
        <button type="button" className="sb-key" onClick={remove}>
          {t("close")}
        </button>
        {error && <span className="sb-error">{error}</span>}
        {d && (
          <button type="button" className="sb-key sb-send" disabled={!canFollow} onClick={() => void follow()}>
            {sending ? "…" : t("follow")} <kbd>{sendLabel()}</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

function Chips({ store, chips, actions, focusReq }: { store: Store; chips: Chip[]; actions: OverlayActions; focusReq: { id: string; n: number } | null }) {
  useChipPolling(store, chips);
  useTick(chips.some((c) => !isFinal(c.dispatch)));
  if (chips.length === 0) return null;
  // 펼친 칩은 늘 보이게, 나머지는 최근 3개
  const visible = chips.filter((c, i) => c.expanded || i >= chips.length - 3);
  const hidden = chips.length - visible.length;
  return (
    <div className="sb-chips">
      {hidden > 0 && <div className="sb-chip sb-more">+{hidden}</div>}
      {visible.map((c) => (
        <ChipCard key={c.id} c={c} store={store} focusReq={focusReq} onAttach={() => actions.pick({ kind: "chip", id: c.id })} />
      ))}
    </div>
  );
}

function Toast({ store, toast }: { store: Store; toast: { text: string; n: number } | null }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => store.set({ toast: null }), 2500);
    return () => clearTimeout(t);
  }, [toast, store]);
  return toast ? <div className="sb-toast">{toast.text}</div> : null;
}

export type OverlayActions = { pick(target: PickTarget | null): void };

export function App({ store, actions }: { store: Store; actions: OverlayActions }) {
  const state = useStore(store);
  // 세션 목록은 팝업마다 묻지 않고 하나로
  const sessionsState = useSessions(state.popovers.some((p) => p.draft.url === state.url));
  return (
    <>
      {state.popovers
        .filter((c) => c.draft.url === state.url)
        .map((c) => (
          <Popover
            key={c.id}
            store={store}
            c={c}
            sessionsState={sessionsState}
            onAttach={() => actions.pick({ kind: "popover", id: c.id })}
            attaching={state.attaching === c.id}
            focusReq={state.focusReq}
          />
        ))}
      <Chips store={store} chips={state.chips} actions={actions} focusReq={state.focusReq} />
      <Toast store={store} toast={state.toast} />
      {state.picking && state.remoteAttach && (
        <div className="sb-banner">
          <span className="sb-brand">✻</span> {t("remote.banner", { name: state.remoteAttach.name })} <span className="sb-muted">{t("remote.esc")}</span>
        </div>
      )}
    </>
  );
}
