import type { ElementInfo, Rect } from "@switchboard/protocol";

/** 페이지 DOM에서 요소 정보를 모은다. 입력값·비밀번호는 담지 않는다. */

const STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "box-sizing",
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
  "border", "border-radius", "z-index", "overflow", "opacity", "visibility", "transform",
  "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns",
] as const;
const TEST_ID_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa"] as const;
const MAX_HTML = 4096;
const MAX_TEXT = 300;

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function containsRect(outer: Rect, inner: Rect, tolerance = 2): boolean {
  return (
    outer.x - tolerance <= inner.x &&
    outer.y - tolerance <= inner.y &&
    outer.x + outer.width + tolerance >= inner.x + inner.width &&
    outer.y + outer.height + tolerance >= inner.y + inner.height
  );
}

export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function isUnique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** 빌드 도구가 만든 해시 클래스(css-modules, styled-components 등)는 선택자에서 뺀다. */
function stableClasses(el: Element): string[] {
  return Array.from(el.classList)
    .filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && !/(^|[_-])[a-zA-Z0-9]{5,}$/.test(c.replace(/^[a-z]+/, "")) && c.length <= 40)
    .slice(0, 2);
}

function stableId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && !/^(radix|headlessui|react-aria|mui)-/i.test(id);
}

export function uniqueSelector(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id && stableId(el.id) && isUnique(doc, `#${cssEscape(el.id)}`, el)) return `#${cssEscape(el.id)}`;
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      const sel = `[${attr}="${cssEscape(v)}"]`;
      if (isUnique(doc, sel, el)) return sel;
    }
  }
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== doc.documentElement && depth < 8; depth++) {
    if (node !== el && node.id && stableId(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const classes = stableClasses(node);
    if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join("");
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (isUnique(doc, sel, el)) return sel;
    node = parent;
  }
  return parts.join(" > ");
}

/** 입력값과 스크립트를 지우고, 긴 속성값을 줄여 4KB 안에 맞춘다. */
export function sanitizedOuterHTML(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  const all = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (const node of all) {
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style") {
      node.textContent = "";
      continue;
    }
    if (tag === "input" || tag === "select" || tag === "option") node.removeAttribute("value");
    if (tag === "textarea") node.textContent = "";
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith("data-sb-")) node.removeAttribute(attr.name);
      else if (attr.value.length > 200) node.setAttribute(attr.name, `${attr.value.slice(0, 60)}…`);
    }
  }
  const html = clone.outerHTML;
  if (html.length <= MAX_HTML) return html;
  const marker = "<!-- … -->";
  return html.slice(0, MAX_HTML - marker.length) + marker;
}

function collapse(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function collectElement(el: Element): ElementInfo {
  const view = el.ownerDocument.defaultView;
  const computed = view ? view.getComputedStyle(el) : null;
  const styles: Record<string, string> = {};
  if (computed) for (const p of STYLE_PROPS) {
    const v = computed.getPropertyValue(p);
    if (v) styles[p] = v;
  }
  const html = el as HTMLElement;
  const info: ElementInfo = {
    selector: uniqueSelector(el),
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList).slice(0, 20),
    text: collapse(html.innerText ?? el.textContent ?? "", MAX_TEXT),
    outerHTML: sanitizedOuterHTML(el),
    styles,
    rect: rectOf(el),
  };
  if (el.id) info.id = el.id;
  const role = el.getAttribute("role");
  if (role) info.role = role;
  const aria = el.getAttribute("aria-label");
  if (aria) info.ariaLabel = collapse(aria, 200);
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      info.testId = v;
      break;
    }
  }
  return info;
}

export type RegionPick = { primary: Element; others: Element[] };

/** 영역 안에 60% 이상 들어온 요소 중 가장 바깥 것들. */
function topMostInside(root: Element, region: Rect, max = 12): Element[] {
  const inside = Array.from(root.querySelectorAll("*"))
    .slice(0, 4000)
    .filter((el) => {
      const r = rectOf(el);
      const area = r.width * r.height;
      return area >= 16 && intersectionArea(r, region) / area >= 0.6;
    });
  return inside.filter((el) => !inside.some((o) => o !== el && o.contains(el))).slice(0, max);
}

/**
 * 드래그 영역 → 대표 요소 + 영역 안의 주요 요소.
 * 1) 영역을 포함하는 가장 작은 요소에서 시작한다.
 * 2) 영역 안 요소가 하나뿐이고 그 요소가 영역을 대부분(70%) 채우면 대표를 그 요소로 내리고 한 단계 더 들어간다.
 *    (카드 목록을 감싸 드래그하면 대표 = 목록, 나머지 = 카드들)
 */
export function pickRegion(region: Rect, topAt: (x: number, y: number) => Element | null, doc: Document = document): RegionPick {
  const body = doc.body ?? doc.documentElement;
  let primary: Element | null = topAt(region.x + region.width / 2, region.y + region.height / 2);
  while (primary && primary !== body && !containsRect(rectOf(primary), region)) primary = primary.parentElement;
  primary ??= body;

  const regionArea = region.width * region.height;
  let inside = topMostInside(primary, region);
  for (let depth = 0; depth < 10 && inside.length === 1; depth++) {
    const only = inside[0]!;
    if (intersectionArea(rectOf(only), region) < 0.7 * regionArea) break;
    primary = only;
    inside = topMostInside(only, region);
  }
  return { primary, others: inside };
}
