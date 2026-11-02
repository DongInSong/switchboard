import type { Chip, Composing, Link } from "./overlay/store.ts";

/**
 * 열려 있는 작성 팝업(초안)과 상태 칩을 백그라운드가 보관한다(chrome.storage.session: 브라우저를 닫으면 사라짐).
 * - 새로고침·이동 뒤에도 되살린다(초안은 탭+주소별, 칩은 탭별로 따라다님).
 * - 다른 페이지·탭의 선택을 초안에 연계 대상으로 붙인다(레퍼런스).
 * 페이지 쪽 오버레이는 상태를 통째로 보내고(sync), 여기서 그 페이지 몫만 갈아 끼운다.
 */

export type StoredDraft = { tabId: number; url: string; title: string; updatedAt: number; composing: Composing };
export type DraftSummary = { id: string; tabId: number; url: string; title: string; name: string; text: string; links: number; sameTab: boolean };
export type Armed = { draftId: string; tabId: number; url: string; at: number };

export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const DRAFTS = "sb:drafts";
const ARMED = "sb:armed";
const chipsKey = (tabId: number) => `sb:chips:${tabId}`;
/** 연계 대기(alt+a 뒤 다른 페이지에서 고르기)는 5분 뒤 풀린다. 잊고 있다가 엉뚱한 요청에 붙지 않게. */
export const ARM_TTL_MS = 5 * 60_000;
const MAX_DRAFTS = 24;

export class DraftStore {
  readonly #kv: KV;
  readonly #now: () => number;

  constructor(kv: KV, now: () => number = Date.now) {
    this.#kv = kv;
    this.#now = now;
  }

  async #all(): Promise<Record<string, StoredDraft>> {
    const v = await this.#kv.get(DRAFTS);
    return v && typeof v === "object" ? (v as Record<string, StoredDraft>) : {};
  }

  async #save(all: Record<string, StoredDraft>): Promise<void> {
    const entries = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_DRAFTS);
    await this.#kv.set(DRAFTS, Object.fromEntries(entries));
  }

  /**
   * 오버레이가 맡은 주소들(scope) 안의 초안을 통째로 갈아 끼우고, 탭의 칩도 갈아 끼운다.
   * 초안은 저마다 캡처한 주소(draft.url)에 묶인다(SPA에서 주소만 바뀌어도 섞이지 않게).
   */
  async sync(tabId: number, scope: readonly string[], popovers: Composing[], chips: Chip[]): Promise<void> {
    const all = await this.#all();
    const urls = new Set([...scope, ...popovers.map((p) => p.draft.url)]);
    for (const [id, d] of Object.entries(all)) if (d.tabId === tabId && urls.has(d.url) && !popovers.some((p) => p.id === id)) delete all[id];
    const now = this.#now();
    for (const p of popovers) all[p.id] = { tabId, url: p.draft.url, title: p.draft.title, updatedAt: now, composing: p };
    await this.#save(all);
    await this.#kv.set(chipsKey(tabId), chips);
  }

  async restore(tabId: number, url: string): Promise<{ popovers: Composing[]; chips: Chip[] }> {
    const all = await this.#all();
    const popovers = Object.values(all)
      .filter((d) => d.tabId === tabId && d.url === url)
      .map((d) => d.composing);
    const chips = ((await this.#kv.get(chipsKey(tabId))) as Chip[] | undefined) ?? [];
    return { popovers, chips };
  }

  /** 이 페이지가 아닌 곳에 열려 있는 초안들(연계할 곳 고르기). */
  async others(tabId: number, url: string): Promise<DraftSummary[]> {
    const all = await this.#all();
    return Object.entries(all)
      .filter(([, d]) => !(d.tabId === tabId && d.url === url))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([id, d]) => ({
        id,
        tabId: d.tabId,
        url: d.url,
        title: d.title,
        name: d.composing.name,
        text: d.composing.text,
        links: d.composing.links.length,
        sameTab: d.tabId === tabId,
      }));
  }

  /** 초안에 연계 대상을 덧붙인다. 그 초안이 있는 탭(살아 있으면 알려 줄 곳)을 돌려준다. */
  async link(targetId: string, links: Link[]): Promise<StoredDraft | null> {
    const all = await this.#all();
    const d = all[targetId];
    if (!d) return null;
    const known = new Set(d.composing.links.map((l) => l.id));
    d.composing = { ...d.composing, links: [...d.composing.links, ...links.filter((l) => !known.has(l.id))] };
    d.updatedAt = this.#now();
    await this.#save(all);
    return d;
  }

  async hasPageState(tabId: number, url: string): Promise<boolean> {
    const { popovers, chips } = await this.restore(tabId, url);
    return popovers.length > 0 || chips.length > 0;
  }

  async forgetTab(tabId: number): Promise<void> {
    const all = await this.#all();
    for (const [id, d] of Object.entries(all)) if (d.tabId === tabId) delete all[id];
    await this.#save(all);
    await this.#kv.remove(chipsKey(tabId));
  }

  async arm(draftId: string, tabId: number, url: string): Promise<void> {
    await this.#kv.set(ARMED, { draftId, tabId, url, at: this.#now() } satisfies Armed);
  }

  async disarm(): Promise<void> {
    await this.#kv.remove(ARMED);
  }

  /** 다른 페이지에서 고르면 붙일 초안. 만료됐거나 초안이 사라졌으면 없음. */
  async armed(): Promise<(Armed & { name: string }) | null> {
    const a = (await this.#kv.get(ARMED)) as Armed | undefined;
    if (!a || this.#now() - a.at > ARM_TTL_MS) return null;
    const d = (await this.#all())[a.draftId];
    return d ? { ...a, name: d.composing.name } : null;
  }
}

/** chrome.storage.session 어댑터. */
export function sessionKV(): KV {
  return {
    get: async (key) => (await browser.storage.session.get(key))[key],
    set: (key, value) => browser.storage.session.set({ [key]: value }),
    remove: (key) => browser.storage.session.remove(key),
  };
}
