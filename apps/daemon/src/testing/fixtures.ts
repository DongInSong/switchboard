import type { Capture } from "@switchboard/protocol";

export function sampleCapture(over: Partial<Capture> = {}): Capture {
  const el = {
    selector: "header > button.avatar",
    tag: "button",
    classes: ["avatar"],
    text: "DS",
    outerHTML: '<button class="avatar">DS</button>',
    styles: { display: "flex" },
    rect: { x: 300, y: 10, width: 40, height: 40 },
  };
  return {
    url: "http://localhost:5199/settings",
    title: "Fixture",
    capturedAt: 1,
    viewport: { width: 390, height: 844, dpr: 3, scrollX: 0, scrollY: 0 },
    selection: { mode: "element", rect: el.rect, primary: el, others: [] },
    source: [{ file: "http://localhost:5199/src/AvatarMenu.tsx?t=1", line: 12, framework: "react", via: "react-debug-stack", componentStack: [{ name: "AvatarMenu" }, { name: "Header" }] }],
    screenshots: { element: "element", viewport: "viewport" },
    ...over,
  };
}
