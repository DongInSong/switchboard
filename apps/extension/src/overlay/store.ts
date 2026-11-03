import type { Lang } from "../i18n.ts";
import type { Dispatch, Recommendation, Rect, SourceHint } from "@switchboard/protocol";
import { useSyncExternalStore } from "react";
import type { Thumb } from "../crop.ts";
import type { CaptureDraft } from "../messages.ts";

export type Composing = {
  /** 팝업 식별자(여러 개를 동시에 띄운다). */
  id: string;
  /** 쌓임 순서. 누른 팝업이 맨 위. DOM 순서를 바꾸면 입력 포커스가 풀리므로 z-index로만 올린다. */
  z: number;
  /** 근처에 이미 떠 있는 팝업 수. 그만큼 비켜서 띄운다. */
  cascade: number;
  /** 초안 보존 키: 주소 + 대표 요소 선택자. */
  key: string;
  mode: "element" | "region";
  rect: Rect;
  /** 선택을 끝낸 포인터 위치. 영역 옆에 자리가 없으면 팝업을 여기에 붙인다(예전 초안에는 없다). */
  point?: { x: number; y: number } | undefined;
  /** 머리줄 이름: 컴포넌트 > 선택자. */
  name: string;
  count: number;
  source: SourceHint | undefined;
  draft: CaptureDraft;
  captureId: string | null;
  captureError: string | null;
  /** 업로드 응답에 담겨 오는 첫 추천. */
  recommendations: Recommendation[];
  /** 잘라 낸 스크린샷의 줄인 사본. */
  thumbnail: Thumb | null;
  /** 연계 대상. */
  links: Link[];
  /** 쓰던 요청·고른 세션(새로고침 뒤 복원용으로 store에 둔다). */
  text: string;
  selectedKey: string | null;
  userPicked: boolean;
};

/** 연계 대상: 팝업에 덧붙인 다른 선택(대상 2, 3, …). 따로 찍은 스크린샷을 갖는다. */
export type Link = {
  id: string;
  name: string;
  source: SourceHint | undefined;
  thumbnail: Thumb | null;
  captureId: string | null;
  captureError: string | null;
  /** 다른 페이지에서 붙인 대상(레퍼런스)이면 그 페이지. */
  page?: { url: string; title: string } | undefined;
};

export type Chip = {
  /** 요청 번호. */
  id: number;
  sessionName: string;
  text: string;
  prompt: string;
  expanded: boolean;
  dispatch: Dispatch | null;
  /** 완료 로그에서 이어서 쓰기. */
  followText: string;
  followLinks: Link[];
};

export type OverlayState = {
  /** 지금 주소. SPA에서 주소가 바뀌면 그 주소의 팝업만 보인다. */
  url: string;
  picking: boolean;
  /** 연계 선택 중이면 덧붙일 팝업 id. */
  attaching: string | null;
  /** 이 팝업 입력칸으로 포커스를 돌려 달라는 요청(연계 선택이 끝났을 때). n은 매번 증가. */
  focusReq: { id: string; n: number } | null;
  /** 다른 페이지의 요청에 덧붙이는 중이면 그 요청 이름(선택 중 배너). */
  remoteAttach: { draftId: string; name: string } | null;
  /** 잠깐 보이는 알림. */
  toast: { text: string; n: number } | null;
  /** 화면 언어(바뀌면 다시 그린다). */
  lang: Lang;
  /** 열려 있는 작성 팝업들. */
  popovers: Composing[];
  chips: Chip[];
};

export type Store = {
  get(): OverlayState;
  set(patch: Partial<OverlayState> | ((s: OverlayState) => Partial<OverlayState>)): void;
  subscribe(fn: () => void): () => void;
};

export function createStore(initial: OverlayState): Store {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function updatePopover(store: Store, id: string, patch: Partial<Composing>): void {
  store.set((s) => ({ popovers: s.popovers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function updateLink(store: Store, popoverId: string, linkId: string, patch: Partial<Link>): void {
  store.set((s) => ({
    popovers: s.popovers.map((p) => (p.id === popoverId ? { ...p, links: p.links.map((l) => (l.id === linkId ? { ...l, ...patch } : l)) } : p)),
  }));
}

export function updateChip(store: Store, id: number, patch: Partial<Chip> | ((c: Chip) => Partial<Chip>)): void {
  store.set((s) => ({ chips: s.chips.map((c) => (c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c)) }));
}

export function closePopover(store: Store, id: string): void {
  store.set((s) => ({ popovers: s.popovers.filter((p) => p.id !== id) }));
}

export function raisePopover(store: Store, id: string): void {
  const s = store.get();
  const top = Math.max(0, ...s.popovers.map((p) => p.z));
  const me = s.popovers.find((p) => p.id === id);
  if (me && me.z !== top) updatePopover(store, id, { z: top + 1 });
}

export function useStore(store: Store): OverlayState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** 닫아도 30분 동안 남는 초안. */
const DRAFT_TTL_MS = 30 * 60_000;
const drafts = new Map<string, { text: string; at: number }>();

export function loadDraft(key: string): string {
  const d = drafts.get(key);
  if (!d || Date.now() - d.at > DRAFT_TTL_MS) return "";
  return d.text;
}

export function saveDraft(key: string, text: string): void {
  if (text.trim()) drafts.set(key, { text, at: Date.now() });
  else drafts.delete(key);
}
