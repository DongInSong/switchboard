import { describe, expect, it } from "vitest";
import { insideViewport, placeAtPoint } from "./place.ts";

const vp = { width: 1280, height: 800 };
const size = { width: 420, height: 300 };

describe("insideViewport", () => {
  it("여백 안이면 참", () => {
    expect(insideViewport({ x: 8, y: 8, ...size }, vp, 8)).toBe(true);
    expect(insideViewport({ x: 852, y: 492, ...size }, vp, 8)).toBe(true);
  });
  it("위로 넘치면 거짓(주소창 밑으로 들어가던 경우)", () => {
    expect(insideViewport({ x: 100, y: -120, ...size }, vp, 8)).toBe(false);
  });
  it("오른쪽으로 넘치면 거짓", () => {
    expect(insideViewport({ x: 900, y: 100, ...size }, vp, 8)).toBe(false);
  });
});

describe("placeAtPoint", () => {
  it("자리가 있으면 오른쪽 아래로", () => {
    expect(placeAtPoint({ x: 100, y: 100 }, size, vp)).toEqual({ x: 112, y: 112 });
  });
  it("오른쪽 아래 끝에서 놓으면 왼쪽 위로 뒤집는다(큰 영역을 왼쪽 위에서 오른쪽 아래로 끈 경우)", () => {
    expect(placeAtPoint({ x: 1270, y: 790 }, size, vp)).toEqual({ x: 1270 - 12 - 420, y: 790 - 12 - 300 });
  });
  it("왼쪽 위에서 놓으면 오른쪽 아래로(거꾸로 끈 경우)", () => {
    expect(placeAtPoint({ x: 10, y: 10 }, size, vp)).toEqual({ x: 22, y: 22 });
  });
  it("양쪽 다 모자라면 자리가 더 많은 쪽 가장자리에", () => {
    const tall = { width: 420, height: 700 };
    expect(placeAtPoint({ x: 100, y: 300 }, tall, vp).y).toBe(800 - 8 - 700);
    expect(placeAtPoint({ x: 100, y: 600 }, tall, vp).y).toBe(8);
  });
  it("화면보다 크면 왼쪽·위 여백에", () => {
    expect(placeAtPoint({ x: 200, y: 200 }, { width: 2000, height: 1000 }, vp)).toEqual({ x: 8, y: 8 });
  });
  it("창이 줄어 점이 화면 밖이어도 화면 안에", () => {
    const short = { width: 1280, height: 300 };
    const small = { width: 420, height: 218 };
    const p = placeAtPoint({ x: 1270, y: 790 }, small, short);
    expect(insideViewport({ ...p, ...small }, short, 8)).toBe(true);
    expect(p).toEqual({ x: 1270 - 12 - 420, y: 300 - 12 - 218 });
  });
  it("결과는 늘 화면 안", () => {
    for (const x of [0, 5, 300, 640, 1000, 1279]) {
      for (const y of [0, 5, 200, 400, 700, 799]) {
        const p = placeAtPoint({ x, y }, size, vp);
        expect(insideViewport({ ...p, ...size }, vp, 8)).toBe(true);
      }
    }
  });
});
