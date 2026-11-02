import type { SourceHint } from "@switchboard/protocol";

/**
 * 페이지의 MAIN world에서 DOM 요소의 소스 위치를 찾는다.
 * 우선순위: 빌드 마커 → React → Svelte → Vue. 찾은 것을 모두 돌려주며 첫 번째가 가장 믿을 만하다.
 * 프레임워크 내부 구조는 버전마다 바뀌므로 모든 접근은 방어적으로 한다.
 */

type StackEntry = NonNullable<SourceHint["componentStack"]>[number];
type Loose = Record<string, unknown>;

const MARKER_ATTRS = ["data-sb-src", "data-tsd-source", "data-v-inspector", "data-insp-path"] as const;
const MAX_ANCESTORS = 12;
const MAX_STACK = 8;

function obj(v: unknown): Loose | null {
  return typeof v === "object" && v !== null ? (v as Loose) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** "path:12:5", "path:12:5:div", "C:/x/y.tsx:3" → { file, line, column } */
export function parseLocation(value: string): { file: string; line?: number; column?: number } | null {
  const m = /^(.+?):(\d+)(?::(\d+))?(?::[^:/\\]*)?$/.exec(value.trim());
  if (!m) return value.trim() ? { file: value.trim() } : null;
  const loc: { file: string; line?: number; column?: number } = { file: m[1]! };
  const line = Number(m[2]);
  if (line > 0) loc.line = line;
  if (m[3] !== undefined) loc.column = Number(m[3]);
  return loc;
}

function* ancestors(el: Element, max = MAX_ANCESTORS): Generator<Element> {
  let cur: Element | null = el;
  for (let i = 0; cur && i < max; i++, cur = cur.parentElement) yield cur;
}

export function fromMarkers(el: Element): SourceHint | null {
  for (const node of ancestors(el)) {
    for (const attr of MARKER_ATTRS) {
      const value = node.getAttribute(attr);
      const loc = value ? parseLocation(value) : null;
      if (loc) return { ...loc, framework: "marker", via: attr };
    }
  }
  return null;
}

// ---------------------------------------------------------------- React

export type StackFrame = { fn?: string; url: string; line: number; column: number };

/** V8 형식 스택 문자열의 프레임. */
export function parseStackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(raw);
    if (!m) continue;
    const frame: StackFrame = { url: m[2]!, line: Number(m[3]), column: Number(m[4]) };
    if (m[1]) frame.fn = m[1];
    frames.push(frame);
  }
  return frames;
}

const NON_APP = [/\/node_modules\//, /\/@vite\//, /\/@react-refresh/, /\/\.vite\/deps\//, /react-dom/, /jsx-dev-runtime/, /^chrome-extension:/, /^extension:/, /^<anonymous>$/, /\/chunk-[A-Z0-9]+\.js/i];

export function isAppFrame(url: string): boolean {
  return !NON_APP.some((re) => re.test(url));
}

function reactFiber(el: Element): Loose | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  return key ? obj((el as unknown as Loose)[key]) : null;
}

function componentName(type: unknown): string | undefined {
  if (typeof type === "function") {
    const f = type as unknown as Loose;
    return str(f.displayName) ?? str((type as { name?: unknown }).name);
  }
  const t = obj(type);
  if (!t) return undefined;
  return str(t.displayName) ?? componentName(t.render) ?? componentName(t.type);
}

/** fiber가 만들어진 JSX 위치. React 18 이하는 _debugSource, 19는 _debugStack의 첫 앱 프레임. */
function fiberLocation(fiber: Loose): { file: string; line?: number; column?: number; approx: boolean } | null {
  const src = obj(fiber._debugSource);
  const fileName = str(src?.fileName);
  if (src && fileName) {
    const loc: { file: string; line?: number; column?: number; approx: boolean } = { file: fileName, approx: false };
    const line = int(src.lineNumber);
    if (line) loc.line = line;
    const column = int(src.columnNumber);
    if (column) loc.column = column;
    return loc;
  }
  const stack = obj(fiber._debugStack);
  const text = str(stack?.stack);
  if (!text) return null;
  const frame = parseStackFrames(text).find((f) => isAppFrame(f.url));
  return frame ? { file: frame.url, line: frame.line, column: frame.column, approx: true } : null;
}

/** 가장 가까운 컴포넌트 fiber. host fiber(div 등)는 type이 문자열이다. */
function ownerOf(fiber: Loose): Loose | null {
  const owner = obj(fiber._debugOwner);
  if (owner) return owner;
  let cur = obj(fiber.return);
  for (let i = 0; cur && i < 200; i++, cur = obj(cur.return)) {
    if (typeof cur.type === "function" || (obj(cur.type) && componentName(cur.type))) return cur;
  }
  return null;
}

export function fromReact(el: Element, maxStack = MAX_STACK): SourceHint | null {
  for (const node of ancestors(el, 4)) {
    const host = reactFiber(node);
    if (!host) continue;
    const loc = fiberLocation(host);
    const stack: StackEntry[] = [];
    const seen = new Set<Loose>();
    for (let owner = ownerOf(host); owner && stack.length < maxStack && !seen.has(owner); owner = ownerOf(owner)) {
      seen.add(owner);
      const name = componentName(owner.type);
      if (!name) continue;
      const entry: StackEntry = { name };
      const ownerLoc = fiberLocation(owner);
      if (ownerLoc) {
        entry.file = ownerLoc.file;
        if (ownerLoc.line) entry.line = ownerLoc.line;
      }
      stack.push(entry);
    }
    if (!loc && stack.length === 0) return null;
    const hint: SourceHint = { file: loc?.file ?? stack.find((s) => s.file)?.file ?? "", framework: "react", via: loc?.approx ? "react-debug-stack" : "react-debug-source" };
    if (!hint.file) return null;
    if (loc?.line) hint.line = loc.line;
    if (loc?.column) hint.column = loc.column;
    if (loc?.approx) hint.lineApprox = true;
    if (stack.length > 0) hint.componentStack = stack;
    return hint;
  }
  return null;
}

// ---------------------------------------------------------------- Svelte

export function fromSvelte(el: Element): SourceHint | null {
  for (const node of ancestors(el)) {
    const meta = obj((node as unknown as Loose).__svelte_meta);
    const loc = obj(meta?.loc);
    const file = str(loc?.file);
    if (!loc || !file) continue;
    const hint: SourceHint = { file, framework: "svelte", via: "svelte-meta" };
    const line = int(loc.line);
    if (line) hint.line = line;
    if (typeof loc.column === "number") hint.column = loc.column;
    const stack: StackEntry[] = [];
    for (let p = obj(meta?.parent); p && stack.length < MAX_STACK; p = obj(p.parent)) {
      const name = str(p.componentTag);
      if (!name) continue;
      const entry: StackEntry = { name };
      const pf = str(p.file);
      if (pf) entry.file = pf;
      const pl = int(p.line);
      if (pl) entry.line = pl;
      stack.push(entry);
    }
    if (stack.length > 0) hint.componentStack = stack;
    return hint;
  }
  return null;
}

// ---------------------------------------------------------------- Vue

export function fromVue(el: Element): SourceHint | null {
  for (const node of ancestors(el)) {
    const n = node as unknown as Loose;
    let instance = obj(n.__vueParentComponent);
    if (instance) {
      const stack: StackEntry[] = [];
      let file: string | undefined;
      for (let i = 0; instance && i < MAX_STACK; i++, instance = obj(instance.parent)) {
        const type = obj(instance.type);
        const f = str(type?.__file);
        file ??= f;
        const name = str(type?.name) ?? str(type?.__name) ?? (f ? f.split("/").pop()?.replace(/\.vue$/, "") : undefined);
        if (name) stack.push(f ? { name, file: f } : { name });
      }
      if (file) return { file, framework: "vue", via: "vue-instance", ...(stack.length ? { componentStack: stack } : {}) };
    }
    const vm2 = obj(n.__vue__);
    const file2 = str(obj(vm2?.$options)?.__file);
    if (file2) return { file: file2, framework: "vue", via: "vue2-instance" };
  }
  return null;
}

// ----------------------------------------------------------------

export function probeElement(el: Element): SourceHint[] {
  const hints: SourceHint[] = [];
  for (const adapter of [fromMarkers, fromReact, fromSvelte, fromVue]) {
    try {
      const h = adapter(el);
      if (h) hints.push(h);
    } catch {
      // 프레임워크 내부 구조가 바뀌어도 다른 어댑터는 계속 시도한다.
    }
  }
  return hints;
}

/** 이름표에 쓸 짧은 컴포넌트 이름. */
export function primaryComponent(hints: readonly SourceHint[]): string | undefined {
  return hints.find((h) => h.componentStack?.length)?.componentStack?.[0]?.name;
}

// ---------------------------------------------------------------- 격리된 world와의 통신

export const PROBE_REQUEST = "switchboard:probe";
export const PROBE_RESULT = "switchboard:probe-result";
export const PROBE_ATTR = "data-sb-probe";

/** MAIN world에 한 번 설치한다. ISOLATED world의 오버레이가 요소에 속성을 달고 이벤트를 보내면 결과를 돌려준다. */
export function installProbeListener(doc: Document = document): void {
  const w = doc.defaultView as (Window & { __switchboardProbe?: boolean }) | null;
  if (!w || w.__switchboardProbe) return;
  w.__switchboardProbe = true;
  doc.addEventListener(PROBE_REQUEST, (ev) => {
    let id = "";
    try {
      id = String(JSON.parse(String((ev as CustomEvent).detail)).id);
    } catch {
      return;
    }
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) return;
    const el = doc.querySelector(`[${PROBE_ATTR}="${id}"]`);
    const hints = el ? probeElement(el) : [];
    doc.dispatchEvent(new CustomEvent(PROBE_RESULT, { detail: JSON.stringify({ id, hints }) }));
  });
}
