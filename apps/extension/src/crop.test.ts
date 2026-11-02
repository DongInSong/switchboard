import { describe, expect, it } from "vitest";
import { cropBox, fitWithin, fromBase64, toBase64 } from "./crop.ts";

describe("cropBox", () => {
  it("비트맵 크기 / 뷰포트 크기로 배율을 구하고 여백을 붙인다", () => {
    expect(cropBox({ x: 100, y: 50, width: 40, height: 20 }, { width: 1000, height: 500 }, { width: 2000, height: 1000 }, 8)).toEqual({
      sx: 184,
      sy: 84,
      sw: 112,
      sh: 72,
    });
  });

  it("화면 밖 부분은 잘라 내고, 완전히 밖이면 null", () => {
    expect(cropBox({ x: -50, y: -50, width: 100, height: 100 }, { width: 100, height: 100 }, { width: 100, height: 100 }, 0)).toEqual({ sx: 0, sy: 0, sw: 50, sh: 50 });
    expect(cropBox({ x: 500, y: 500, width: 10, height: 10 }, { width: 100, height: 100 }, { width: 100, height: 100 }, 0)).toBeNull();
    expect(cropBox({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull();
  });
});

describe("미리보기 도우미", () => {
  it("비율을 지켜 줄이고, maxScale까지만 키운다", () => {
    expect(fitWithin(1000, 500, 336, 220)).toEqual({ width: 336, height: 168 });
    expect(fitWithin(40, 40, 336, 220)).toEqual({ width: 40, height: 40 });
    expect(fitWithin(40, 40, 336, 220, 2)).toEqual({ width: 80, height: 80 });
    expect(fitWithin(0, 10, 10, 10)).toEqual({ width: 0, height: 0 });
  });

  it("base64 왕복 (큰 버퍼 포함)", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});
