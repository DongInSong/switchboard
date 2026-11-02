import { describe, expect, it } from "vitest";
import { ARM_TTL_MS, DraftStore, type KV } from "./drafts.ts";
import type { Chip, Composing, Link } from "./overlay/store.ts";

function memKV(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

function pop(id: string, over: Partial<Composing> = {}, url = "http://a/x", title = "t"): Composing {
  return {
    id,
    z: 1,
    cascade: 0,
    key: id,
    mode: "element",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    name: `Comp-${id}`,
    count: 1,
    source: undefined,
    draft: { url, title, capturedAt: 0, viewport: { width: 1, height: 1, dpr: 1, scrollX: 0, scrollY: 0 }, selection: { mode: "element", rect: { x: 0, y: 0, width: 1, height: 1 }, primary: { selector: "a", tag: "a", classes: [], text: "", outerHTML: "", styles: {}, rect: { x: 0, y: 0, width: 1, height: 1 } }, others: [] }, source: [] },
    captureId: `cap-${id}`,
    captureError: null,
    recommendations: [],
    thumbnail: null,
    links: [],
    text: "",
    selectedKey: null,
    userPicked: false,
    ...over,
  };
}

const link = (id: string, url: string): Link => ({ id, name: "Header", source: undefined, thumbnail: null, captureId: `cap-${id}`, captureError: null, page: { url, title: "다른 페이지" } });

describe("DraftStore", () => {
  it("SPA에서 주소가 바뀌어도 초안은 캡처한 주소에 묶인다", async () => {
    const s = new DraftStore(memKV());
    // 같은 오버레이가 /a에서 만든 팝업을 /b로 넘어간 뒤 동기화
    await s.sync(1, ["http://a/a", "http://a/b"], [pop("pa", {}, "http://a/a")], []);
    expect((await s.restore(1, "http://a/a")).popovers.map((p) => p.id)).toEqual(["pa"]);
    expect((await s.restore(1, "http://a/b")).popovers).toEqual([]);
  });

  it("페이지(탭+주소)별로 갈아 끼우고, 칩은 탭을 따라다닌다", async () => {
    const s = new DraftStore(memKV());
    const chip = { id: 1 } as Chip;
    const S = "http://a/settings";
    const D = "http://a/dashboard";
    await s.sync(1, [S], [pop("p1", { text: "쓰던 글" }, S), pop("p2", {}, S)], [chip]);
    await s.sync(1, [D], [pop("p3", {}, D)], [chip]);
    expect((await s.restore(1, "http://a/settings")).popovers.map((p) => [p.id, p.text])).toEqual([
      ["p1", "쓰던 글"],
      ["p2", ""],
    ]);
    // 같은 페이지에서 p2를 닫으면 그것만 빠진다
    await s.sync(1, [S], [pop("p1", {}, S)], []);
    expect((await s.restore(1, "http://a/settings")).popovers.map((p) => p.id)).toEqual(["p1"]);
    expect((await s.restore(1, "http://a/dashboard")).popovers.map((p) => p.id)).toEqual(["p3"]);
    expect((await s.restore(1, "http://a/other")).chips).toEqual([]);
    expect(await s.hasPageState(2, "http://a/settings")).toBe(false);
  });

  it("다른 페이지 초안 목록과 연계 붙이기(중복 없이)", async () => {
    const s = new DraftStore(memKV());
    await s.sync(1, ["http://a/settings"], [pop("p1", { text: "헤더를 저것처럼" }, "http://a/settings", "설정")], []);
    await s.sync(2, ["http://a/dashboard"], [pop("p2", {}, "http://a/dashboard", "대시보드")], []);
    const others = await s.others(2, "http://a/dashboard");
    expect(others).toEqual([{ id: "p1", tabId: 1, url: "http://a/settings", title: "설정", name: "Comp-p1", text: "헤더를 저것처럼", links: 0, sameTab: false }]);
    const l = link("l1", "http://a/dashboard");
    expect((await s.link("p1", [l]))?.tabId).toBe(1);
    await s.link("p1", [l]);
    expect((await s.restore(1, "http://a/settings")).popovers[0]!.links.map((x) => x.id)).toEqual(["l1"]);
    expect(await s.link("nope", [l])).toBeNull();
  });

  it("연계 대기는 5분 뒤나 초안이 사라지면 풀린다", async () => {
    let t = 1000;
    const s = new DraftStore(memKV(), () => t);
    await s.sync(1, ["http://a/x"], [pop("p1")], []);
    await s.arm("p1", 1, "http://a/x");
    expect(await s.armed()).toMatchObject({ draftId: "p1", name: "Comp-p1" });
    t += ARM_TTL_MS + 1;
    expect(await s.armed()).toBeNull();
    t = 1000;
    await s.sync(1, ["http://a/x"], [], []);
    expect(await s.armed()).toBeNull();
  });

  it("탭을 닫으면 그 탭 몫을 지운다", async () => {
    const kv = memKV();
    const s = new DraftStore(kv);
    await s.sync(1, ["http://a/x"], [pop("p1")], [{ id: 1 } as Chip]);
    await s.forgetTab(1);
    expect(await s.hasPageState(1, "http://a/x")).toBe(false);
  });
});
