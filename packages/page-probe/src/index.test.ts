// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  PROBE_ATTR,
  PROBE_REQUEST,
  PROBE_RESULT,
  fromMarkers,
  fromReact,
  fromSvelte,
  fromVue,
  installProbeListener,
  isAppFrame,
  parseLocation,
  parseStackFrames,
  primaryComponent,
  probeElement,
} from "./index.ts";

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.body.firstElementChild as HTMLElement;
}

describe("parseLocation", () => {
  it.each([
    ["src/App.tsx:12:5", { file: "src/App.tsx", line: 12, column: 5 }],
    ["/abs/x.vue:3", { file: "/abs/x.vue", line: 3 }],
    ["src/a.tsx:10:2:div", { file: "src/a.tsx", line: 10, column: 2 }],
    ["C:/w/b.tsx:7:1", { file: "C:/w/b.tsx", line: 7, column: 1 }],
    ["src/no-line.tsx", { file: "src/no-line.tsx" }],
  ])("%s", (input, expected) => {
    expect(parseLocation(input)).toEqual(expected);
  });
});

describe("빌드 마커", () => {
  it("요소나 조상의 마커 속성을 읽는다", () => {
    const root = html(`<div data-tsd-source="src/Card.tsx:4:3"><span id="t">x</span></div>`);
    expect(fromMarkers(root.querySelector("#t")!)).toEqual({ file: "src/Card.tsx", line: 4, column: 3, framework: "marker", via: "data-tsd-source" });
  });

  it("vue-inspector 형식", () => {
    const el = html(`<p data-v-inspector="src/components/Hello.vue:8:5">hi</p>`);
    expect(fromMarkers(el)).toMatchObject({ file: "src/components/Hello.vue", line: 8, via: "data-v-inspector" });
  });
});

describe("React", () => {
  function attachFiber(el: Element, fiber: object) {
    (el as unknown as Record<string, unknown>)["__reactFiber$abc123"] = fiber;
  }

  it("React 18: _debugSource와 owner 체인으로 위치와 컴포넌트 스택을 만든다", () => {
    function App() {}
    function Header() {}
    const AvatarMenu = Object.assign(() => {}, { displayName: "AvatarMenu" });
    const app = { type: App, _debugSource: { fileName: "/repo/src/main.tsx", lineNumber: 5 } };
    const header = { type: Header, _debugOwner: app, _debugSource: { fileName: "/repo/src/App.tsx", lineNumber: 9 } };
    const menu = { type: AvatarMenu, _debugOwner: header, _debugSource: { fileName: "/repo/src/Header.tsx", lineNumber: 14 } };
    const host = { type: "button", _debugOwner: menu, _debugSource: { fileName: "/repo/src/AvatarMenu.tsx", lineNumber: 21, columnNumber: 7 } };
    const el = html(`<button>DS</button>`);
    attachFiber(el, host);
    const hint = fromReact(el)!;
    expect(hint).toMatchObject({ file: "/repo/src/AvatarMenu.tsx", line: 21, column: 7, framework: "react", via: "react-debug-source" });
    expect(hint.lineApprox).toBeUndefined();
    expect(hint.componentStack?.map((c) => c.name)).toEqual(["AvatarMenu", "Header", "App"]);
    expect(hint.componentStack?.[0]).toEqual({ name: "AvatarMenu", file: "/repo/src/Header.tsx", line: 14 });
  });

  it("React 19: _debugStack의 첫 앱 프레임을 쓰고 줄 번호는 근사치로 표시한다", () => {
    function AvatarMenu() {}
    const stack = [
      "Error: react-stack-top-frame",
      "    at exports.jsxDEV (http://localhost:5199/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b:250:30)",
      "    at AvatarMenu (http://localhost:5199/src/AvatarMenu.tsx?t=1712:31:9)",
      "    at react-stack-bottom-frame (http://localhost:5199/node_modules/.vite/deps/react-dom_client.js?v=1a2b:100:1)",
    ].join("\n");
    const owner = { type: AvatarMenu, _debugStack: { stack: "Error\n    at Header (http://localhost:5199/src/Header.tsx:12:3)" } };
    const host = { type: "div", _debugOwner: owner, _debugStack: { stack } };
    const el = html(`<div>menu</div>`);
    attachFiber(el, host);
    expect(fromReact(el)).toEqual({
      file: "http://localhost:5199/src/AvatarMenu.tsx?t=1712",
      line: 31,
      column: 9,
      lineApprox: true,
      framework: "react",
      via: "react-debug-stack",
      componentStack: [{ name: "AvatarMenu", file: "http://localhost:5199/src/Header.tsx", line: 12 }],
    });
  });

  it("fiber 내부가 이상해도 예외 없이 null", () => {
    const el = html(`<div></div>`);
    attachFiber(el, { type: "div", _debugOwner: 42, _debugStack: { stack: 5 } });
    expect(fromReact(el)).toBeNull();
    expect(probeElement(el)).toEqual([]);
  });

  it("앱 프레임 판별", () => {
    expect(isAppFrame("http://localhost:5199/src/App.tsx")).toBe(true);
    expect(isAppFrame("http://localhost:5199/node_modules/.vite/deps/react-dom_client.js")).toBe(false);
    expect(isAppFrame("http://localhost:5199/@vite/client")).toBe(false);
    expect(parseStackFrames("    at http://x/src/a.tsx:1:2")).toEqual([{ url: "http://x/src/a.tsx", line: 1, column: 2 }]);
  });
});

describe("Svelte와 Vue", () => {
  it("Svelte __svelte_meta", () => {
    const el = html(`<section><b>x</b></section>`);
    (el as unknown as Record<string, unknown>).__svelte_meta = {
      loc: { file: "src/routes/+page.svelte", line: 12, column: 2 },
      parent: { type: "component", componentTag: "Card", file: "src/lib/List.svelte", line: 4, parent: null },
    };
    expect(fromSvelte(el.querySelector("b")!)).toEqual({
      file: "src/routes/+page.svelte",
      line: 12,
      column: 2,
      framework: "svelte",
      via: "svelte-meta",
      componentStack: [{ name: "Card", file: "src/lib/List.svelte", line: 4 }],
    });
  });

  it("Vue 3 인스턴스의 __file과 부모 체인", () => {
    const el = html(`<div></div>`);
    const root = { type: { name: "App", __file: "/repo/src/App.vue" }, parent: null };
    (el as unknown as Record<string, unknown>).__vueParentComponent = { type: { __file: "/repo/src/components/Hello.vue" }, parent: root };
    expect(fromVue(el)).toEqual({
      file: "/repo/src/components/Hello.vue",
      framework: "vue",
      via: "vue-instance",
      componentStack: [
        { name: "Hello", file: "/repo/src/components/Hello.vue" },
        { name: "App", file: "/repo/src/App.vue" },
      ],
    });
  });
});

describe("probeElement와 통신", () => {
  it("마커를 React보다 먼저 둔다", () => {
    const el = html(`<i data-sb-src="src/X.tsx:1:1"></i>`);
    (el as unknown as Record<string, unknown>)["__reactFiber$x"] = { type: "i", _debugSource: { fileName: "src/Y.tsx", lineNumber: 2 } };
    expect(probeElement(el).map((h) => h.via)).toEqual(["data-sb-src", "react-debug-source"]);
    expect(primaryComponent([{ file: "a", framework: "react", via: "x", componentStack: [{ name: "Menu" }] }])).toBe("Menu");
  });

  it("속성이 달린 요소를 찾아 결과 이벤트로 돌려준다", async () => {
    html(`<div data-tsd-source="src/A.tsx:3:1"><button ${PROBE_ATTR}="req-1">go</button></div>`);
    installProbeListener(document);
    installProbeListener(document); // 두 번 설치해도 한 번만 응답
    const results: string[] = [];
    document.addEventListener(PROBE_RESULT, (e) => results.push(String((e as CustomEvent).detail)));
    document.dispatchEvent(new CustomEvent(PROBE_REQUEST, { detail: JSON.stringify({ id: "req-1" }) }));
    document.dispatchEvent(new CustomEvent(PROBE_REQUEST, { detail: JSON.stringify({ id: 'x"]' }) }));
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]!)).toEqual({ id: "req-1", hints: [{ file: "src/A.tsx", line: 3, column: 1, framework: "marker", via: "data-tsd-source" }] });
  });
});
