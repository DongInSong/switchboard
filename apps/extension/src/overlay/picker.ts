import type { Rect } from "@switchboard/protocol";
import { normalizeRect, pickRegion, rectOf } from "./collect.ts";

/** point: 마지막 포인터 위치(드래그를 끝낸 점·클릭한 점). 영역 옆에 자리가 없을 때 팝업을 여기에 붙인다. */
export type PickResult = { mode: "element" | "region"; rect: Rect; point: { x: number; y: number }; primary: Element; others: Element[] };

/** 이름표: 컴포넌트(강조) · 선택자 · 파일:줄(흐리게). */
export type LabelParts = { comp?: string | undefined; sel: string; src?: string | undefined };

export type PickerOptions = {
  root: ShadowRoot;
  host: HTMLElement;
  onDone(result: PickResult): void;
  onCancel(): void;
  /** 이름표 내용. 소스 위치는 비동기로 채운다. */
  describe(el: Element): Promise<LabelParts>;
};

const DRAG_THRESHOLD = 6;

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function shortLabel(el: Element): string {
  const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
  return `${el.tagName.toLowerCase()}${cls}`;
}

/**
 * 1회성 선택 도구. 투명한 유리판으로 페이지 이벤트를 막고, 아래 요소는 elementsFromPoint로 찾는다.
 * 클릭 = 요소, 드래그 = 영역, Shift+클릭 = 추가, ↑/↓ = 부모/자식, Enter = 마침, Esc·우클릭 = 취소.
 */
export class Picker {
  readonly #o: PickerOptions;
  readonly #glass = div("sb-glass");
  readonly #outline = div("sb-outline");
  readonly #label = div("sb-label");
  readonly #region = div("sb-region");
  #marks: HTMLDivElement[] = [];
  #hover: Element | null = null;
  #down: Element[] = [];
  #multi: Element[] = [];
  #start: { x: number; y: number } | null = null;
  #dragging = false;
  #raf = 0;
  #point = { x: 0, y: 0 };
  #labelSeq = 0;
  #active = false;

  constructor(o: PickerOptions) {
    this.#o = o;
  }

  get active(): boolean {
    return this.#active;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#o.root.append(this.#glass, this.#outline, this.#label, this.#region);
    this.#outline.hidden = this.#label.hidden = this.#region.hidden = true;
    this.#glass.addEventListener("pointermove", this.#onMove);
    this.#glass.addEventListener("pointerdown", this.#onDown);
    this.#glass.addEventListener("pointerup", this.#onUp);
    this.#glass.addEventListener("wheel", this.#onWheel, { passive: false });
    // 우클릭 = 취소. 메뉴가 페이지에 뜨지 않게 contextmenu에서 처리한다(Windows는 마우스를 뗄 때 발생).
    this.#glass.addEventListener("contextmenu", this.#onContextMenu);
    window.addEventListener("keydown", this.#onKey, true);
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    cancelAnimationFrame(this.#raf);
    window.removeEventListener("keydown", this.#onKey, true);
    for (const el of [this.#glass, this.#outline, this.#label, this.#region, ...this.#marks]) el.remove();
    this.#marks = [];
    this.#multi = [];
    this.#hover = null;
    this.#down = [];
    this.#start = null;
    this.#dragging = false;
  }

  #elementAt(x: number, y: number): Element | null {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el !== this.#o.host && !this.#o.host.contains(el)) return el;
    }
    return null;
  }

  #setHover(el: Element | null) {
    if (el === this.#hover) return;
    this.#hover = el;
    if (!el) {
      this.#outline.hidden = this.#label.hidden = true;
      return;
    }
    this.#place(this.#outline, rectOf(el));
    this.#outline.hidden = false;
    const seq = ++this.#labelSeq;
    this.#showLabel({ sel: shortLabel(el) }, rectOf(el));
    void this.#o.describe(el).then((parts) => {
      if (seq === this.#labelSeq && this.#hover === el) this.#showLabel(parts, rectOf(el));
    });
  }

  #place(node: HTMLElement, r: Rect) {
    node.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`;
    node.style.width = `${Math.max(0, Math.round(r.width))}px`;
    node.style.height = `${Math.max(0, Math.round(r.height))}px`;
  }

  #showLabel(parts: LabelParts, r: Rect) {
    const span = (cls: string, text: string) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const nodes: Node[] = [];
    if (parts.comp) nodes.push(span("l-comp", parts.comp), document.createTextNode("  "));
    nodes.push(span(parts.comp ? "l-dim" : "", parts.sel));
    if (parts.src) nodes.push(document.createTextNode("  "), span("l-dim", parts.src));
    this.#label.replaceChildren(...nodes);
    this.#label.hidden = false;
    const h = 22;
    const y = r.y - h - 4 >= 0 ? r.y - h - 4 : Math.min(window.innerHeight - h, r.y + r.height + 4);
    const x = Math.max(4, Math.min(r.x, window.innerWidth - this.#label.offsetWidth - 4));
    this.#label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  #onMove = (e: PointerEvent) => {
    this.#point = { x: e.clientX, y: e.clientY };
    if (this.#start && !this.#dragging && Math.hypot(e.clientX - this.#start.x, e.clientY - this.#start.y) > DRAG_THRESHOLD) {
      this.#dragging = true;
      this.#outline.hidden = this.#label.hidden = true;
      this.#region.hidden = false;
    }
    if (this.#dragging && this.#start) {
      this.#place(this.#region, normalizeRect(this.#start.x, this.#start.y, e.clientX, e.clientY));
      return;
    }
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame(() => {
      this.#down = [];
      this.#setHover(this.#elementAt(this.#point.x, this.#point.y));
    });
  };

  #onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.#glass.setPointerCapture(e.pointerId);
    this.#start = { x: e.clientX, y: e.clientY };
    this.#dragging = false;
  };

  #onUp = (e: PointerEvent) => {
    if (e.button !== 0 || !this.#start) return;
    e.preventDefault();
    const start = this.#start;
    this.#start = null;
    if (this.#dragging) {
      this.#dragging = false;
      const rect = normalizeRect(start.x, start.y, e.clientX, e.clientY);
      this.#region.hidden = true;
      if (rect.width < 4 || rect.height < 4) return;
      const { primary, others } = pickRegion(rect, (x, y) => this.#elementAt(x, y));
      this.#finish({ mode: "region", rect, point: { x: e.clientX, y: e.clientY }, primary, others });
      return;
    }
    const el = this.#hover ?? this.#elementAt(e.clientX, e.clientY);
    if (!el) return;
    if (e.shiftKey) {
      this.#toggleMulti(el);
      return;
    }
    const list = this.#multi.includes(el) ? this.#multi : [...this.#multi, el];
    this.#finishElements(list, { x: e.clientX, y: e.clientY });
  };

  #onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    this.stop();
    this.#o.onCancel();
  };

  #onWheel = (e: WheelEvent) => {
    // 유리판이 휠을 받으므로, 포인터 아래에서 스크롤 가능한 가장 가까운 요소를 대신 스크롤한다.
    e.preventDefault();
    let node: Element | null = this.#elementAt(e.clientX, e.clientY);
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      const canY = /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight;
      const canX = /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth;
      if ((canY && e.deltaY) || (canX && e.deltaX)) break;
      node = node.parentElement;
    }
    const target = node && node !== document.documentElement ? node : (document.scrollingElement ?? document.documentElement);
    target.scrollBy({ left: e.deltaX, top: e.deltaY });
    if (this.#hover) this.#place(this.#outline, rectOf(this.#hover));
    for (const [i, el] of this.#multi.entries()) if (this.#marks[i]) this.#place(this.#marks[i]!, rectOf(el));
  };

  #onKey = (e: KeyboardEvent) => {
    const handled = ["Escape", "ArrowUp", "ArrowDown", "Enter"];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      this.stop();
      this.#o.onCancel();
    } else if (e.key === "ArrowUp" && this.#hover) {
      const parent = this.#hover.parentElement;
      if (parent && parent !== document.documentElement) {
        this.#down.push(this.#hover);
        this.#setHover(parent);
      }
    } else if (e.key === "ArrowDown" && this.#hover) {
      const back = this.#down.pop();
      const next = back && this.#hover.contains(back) ? back : this.#hover.firstElementChild;
      if (next) this.#setHover(next);
    } else if (e.key === "Enter") {
      const list = this.#multi.length ? this.#multi : this.#hover ? [this.#hover] : [];
      if (list.length) this.#finishElements(list, this.#point);
    }
  };

  #toggleMulti(el: Element) {
    const i = this.#multi.indexOf(el);
    if (i >= 0) {
      this.#multi.splice(i, 1);
      this.#marks.splice(i, 1)[0]?.remove();
      return;
    }
    this.#multi.push(el);
    const mark = div("sb-mark");
    this.#place(mark, rectOf(el));
    this.#o.root.append(mark);
    this.#marks.push(mark);
  }

  #finishElements(list: Element[], point: { x: number; y: number }) {
    const [primary, ...others] = list;
    if (!primary) return;
    const rects = list.map(rectOf);
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.width));
    const y1 = Math.max(...rects.map((r) => r.y + r.height));
    this.#finish({ mode: "element", rect: normalizeRect(x0, y0, x1, y1), point, primary, others });
  }

  #finish(result: PickResult) {
    this.stop();
    this.#o.onDone(result);
  }
}
