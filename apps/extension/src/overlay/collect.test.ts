// @vitest-environment happy-dom
import type { Rect } from "@switchboard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crossCheck } from "./collect.testutil.ts";
import { collectElement, containsRect, intersectionArea, normalizeRect, pickRegion, sanitizedOuterHTML, uniqueSelector } from "./collect.ts";

function mount(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body;
}

/** happy-dom은 레이아웃이 없으므로 요소별 사각형을 직접 준다. */
function layout(rects: Record<string, Rect>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const key = this.id || this.className || this.tagName.toLowerCase();
    const r = rects[key] ?? { x: 0, y: 0, width: 0, height: 0 };
    return { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} } as DOMRect;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("사각형 계산", () => {
  it("교차 면적, 포함, 정규화", () => {
    expect(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25);
    expect(intersectionArea({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 })).toBe(0);
    expect(containsRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 1, y: -1, width: 99, height: 50 })).toBe(true);
    expect(normalizeRect(10, 20, 0, 5)).toEqual({ x: 0, y: 5, width: 10, height: 15 });
  });
});

describe("uniqueSelector", () => {
  it("고유한 id, data-testid, 경로 순으로 쓴다", () => {
    mount(`<div id="app"><ul class="list"><li class="item">a</li><li class="item">b</li></ul><button data-testid="save">s</button></div>`);
    expect(uniqueSelector(document.getElementById("app")!)).toBe("#app");
    expect(uniqueSelector(document.querySelector("button")!)).toBe('[data-testid="save"]');
    const second = document.querySelectorAll("li")[1]!;
    const sel = uniqueSelector(second);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)).toBe(second);
  });

  it("해시 클래스와 자동 생성 id는 쓰지 않는다", () => {
    mount(`<section><p id="radix-123" class="Header_title__a1b2c text">x</p><p class="text">y</p></section>`);
    const sel = uniqueSelector(document.querySelector("p")!);
    expect(sel).not.toContain("radix");
    expect(sel).not.toContain("Header_title__a1b2c");
    expect(crossCheck(sel)).toBe(document.querySelector("p"));
  });
});

describe("sanitizedOuterHTML", () => {
  it("입력값·비밀번호·스크립트를 지우고 긴 속성을 줄인다", () => {
    mount(`<form><input name="email" value="me@example.com"><input type="password" value="hunter2"><textarea>비밀</textarea><script>alert(1)</script><svg><path d="${"M0 0 ".repeat(100)}"/></svg></form>`);
    const html = sanitizedOuterHTML(document.querySelector("form")!);
    expect(html).not.toContain("me@example.com");
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("비밀");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("…");
  });

  it("4KB를 넘지 않는다", () => {
    mount(`<div>${"<p>긴 문단입니다</p>".repeat(1000)}</div>`);
    expect(sanitizedOuterHTML(document.querySelector("div")!).length).toBeLessThanOrEqual(4096);
  });

  it("collectElement는 스키마 제한(텍스트 300자)을 지킨다", () => {
    mount(`<p class="a b" role="note" aria-label="설명" data-testid="t">${"가".repeat(500)}</p>`);
    const info = collectElement(document.querySelector("p")!);
    expect(info).toMatchObject({ tag: "p", classes: ["a", "b"], role: "note", ariaLabel: "설명", testId: "t" });
    expect(info.text.length).toBeLessThanOrEqual(300);
  });
});

describe("pickRegion", () => {
  const html = `<main id="main"><h1 id="title">설정</h1><section id="cards"><article id="c1"></article><article id="c2"></article><article id="c3"></article></section></main>`;
  const rects: Record<string, Rect> = {
    main: { x: 0, y: 0, width: 1000, height: 400 },
    title: { x: 24, y: 24, width: 300, height: 40 },
    cards: { x: 24, y: 100, width: 900, height: 120 },
    c1: { x: 24, y: 100, width: 280, height: 120 },
    c2: { x: 324, y: 100, width: 280, height: 120 },
    c3: { x: 624, y: 100, width: 280, height: 120 },
  };

  it("목록을 감싸 드래그하면 대표 = 목록, 나머지 = 항목들", () => {
    mount(html);
    layout(rects);
    const region = { x: 18, y: 94, width: 900, height: 132 };
    const { primary, others } = pickRegion(region, () => document.getElementById("cards"));
    expect(primary.id).toBe("cards");
    expect(others.map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("요소 하나를 꼭 맞게 감싸면 그 요소가 대표", () => {
    mount(html);
    layout(rects);
    const { primary, others } = pickRegion({ x: 320, y: 96, width: 288, height: 128 }, () => document.getElementById("c2"));
    expect(primary.id).toBe("c2");
    expect(others).toEqual([]);
  });

  it("여러 묶음에 걸치면 공통 조상이 대표", () => {
    mount(html);
    layout(rects);
    const { primary, others } = pickRegion({ x: 10, y: 10, width: 950, height: 240 }, () => document.getElementById("main"));
    expect(primary.id).toBe("main");
    expect(others.map((e) => e.id)).toEqual(["title", "cards"]);
  });
});
