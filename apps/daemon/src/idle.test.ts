import { describe, expect, it } from "vitest";
import { shouldIdleExit } from "./idle.ts";

describe("idle exit", () => {
  const base = { now: 100 * 60_000, lastActivity: 60 * 60_000, idleMs: 30 * 60_000, activeDispatches: 0 };
  it("쓰지 않은 지 기한이 지나고 진행 중인 전달이 없을 때만", () => {
    expect(shouldIdleExit(base)).toBe(true);
    expect(shouldIdleExit({ ...base, lastActivity: 80 * 60_000 })).toBe(false);
    expect(shouldIdleExit({ ...base, activeDispatches: 1 })).toBe(false);
    expect(shouldIdleExit({ ...base, idleMs: 0 })).toBe(false);
  });
});
