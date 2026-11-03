/**
 * 작성 팝업 위치 보조. 기본은 선택 영역 옆(floating-ui)이고, 옆 어디에도 자리가 없을 때(큰 영역) 마우스를 놓은 점에 붙인다.
 */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Box = Point & Size;

/** 상자가 화면 안(가장자리 여백 pad 포함)에 다 들어오는지. 소수점 반올림 오차는 봐준다. */
export function insideViewport(b: Box, vp: Size, pad: number): boolean {
  const e = 0.5;
  return b.x >= pad - e && b.y >= pad - e && b.x + b.width <= vp.width - pad + e && b.y + b.height <= vp.height - pad + e;
}

/**
 * 점 옆에 띄우기(우클릭 메뉴처럼): 오른쪽·아래로 펼치되, 자리가 없으면 왼쪽·위로 뒤집는다.
 * 양쪽 다 모자라면 자리가 더 많은 쪽 가장자리에 붙인다. 결과는 늘 화면 안이다(팝업이 화면보다 크면 왼쪽·위 여백에 맞춘다).
 */
export function placeAtPoint(p: Point, size: Size, vp: Size, { pad = 8, gap = 12 }: { pad?: number; gap?: number } = {}): Point {
  const axis = (raw: number, len: number, room: number) => {
    // 창이 줄어 점이 화면 밖에 남은 경우: 화면 가장자리로 당겨서 계산
    const at = Math.min(Math.max(raw, 0), room);
    const end = Math.max(pad, room - pad - len);
    const clamp = (v: number) => Math.min(Math.max(v, pad), end);
    if (at + gap + len <= room - pad) return clamp(at + gap);
    if (at - gap - len >= pad) return clamp(at - gap - len);
    return room - at > at ? end : pad;
  };
  return { x: axis(p.x, size.width, vp.width), y: axis(p.y, size.height, vp.height) };
}
