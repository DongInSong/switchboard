import { describe, expect, it } from "vitest";
import { altDigit, altLabel, isAlt, sendLabel } from "./keys.ts";

describe("단축키", () => {
  it("맥 Option+A(å)도, AZERTY의 alt+a도 alt+a로 본다", () => {
    expect(isAlt({ altKey: true, key: "å", code: "KeyA" }, "a")).toBe(true);
    expect(isAlt({ altKey: true, key: "a", code: "KeyQ" }, "a")).toBe(true);
    expect(isAlt({ altKey: true, key: "A", code: "KeyA" }, "a")).toBe(true);
    expect(isAlt({ altKey: false, key: "a", code: "KeyA" }, "a")).toBe(false);
    expect(isAlt({ altKey: true, key: "π", code: "KeyP" }, "a")).toBe(false);
  });
  it("alt+숫자(맥 Option+1 = ¡)", () => {
    expect(altDigit({ altKey: true, key: "¡", code: "Digit1" })).toBe(1);
    expect(altDigit({ altKey: true, key: "3", code: "Digit3" })).toBe(3);
    expect(altDigit({ altKey: false, key: "1", code: "Digit1" })).toBeNull();
  });
  it("표시: 맥이면 opt/cmd", () => {
    expect(altLabel("a", true)).toBe("opt+a");
    expect(altLabel("a", false)).toBe("alt+a");
    expect(sendLabel(true)).toBe("cmd+⏎");
    expect(sendLabel(false)).toBe("ctrl+⏎");
  });
});
