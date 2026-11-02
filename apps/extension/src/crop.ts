import type { Rect } from "@switchboard/protocol";

export type Box = { sx: number; sy: number; sw: number; sh: number };

/**
 * 뷰포트 좌표의 사각형을 스크린샷 비트맵 좌표로 바꾼다.
 * 배율은 devicePixelRatio 대신 "비트맵 크기 / 뷰포트 크기"로 구한다(확대·축소 상태에서도 맞음).
 * 화면 밖으로 나간 부분은 잘라 내고, 보이는 부분이 없으면 null.
 */
export function cropBox(rect: Rect, viewport: { width: number; height: number }, bitmap: { width: number; height: number }, pad = 8): Box | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const x0 = Math.max(0, Math.floor((rect.x - pad) * scaleX));
  const y0 = Math.max(0, Math.floor((rect.y - pad) * scaleY));
  const x1 = Math.min(bitmap.width, Math.ceil((rect.x + rect.width + pad) * scaleX));
  const y1 = Math.min(bitmap.height, Math.ceil((rect.y + rect.height + pad) * scaleY));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/** 스크린샷(data URL)에서 선택 영역을 잘라 PNG로. 보이는 부분이 없으면 전체 화면을 쓴다. */
export async function cropScreenshot(dataUrl: string, rect: Rect, viewport: { width: number; height: number }): Promise<{ element: Blob; viewport: Blob }> {
  const full = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(full);
  try {
    const box = cropBox(rect, viewport, bitmap);
    if (!box) return { element: full, viewport: full };
    const canvas = new OffscreenCanvas(box.sw, box.sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { element: full, viewport: full };
    ctx.drawImage(bitmap, box.sx, box.sy, box.sw, box.sh, 0, 0, box.sw, box.sh);
    return { element: await canvas.convertToBlob({ type: "image/png" }), viewport: full };
  } finally {
    bitmap.close();
  }
}

export type Thumb = {
  /** base64(PNG/WebP). 확장 메시지는 JSON만 오가므로 문자열로 보낸다. */
  base64: string;
  mime: string;
  /** 잘라 낸 원본 크기(장치 픽셀). */
  sourceWidth: number;
  sourceHeight: number;
};

/** maxW×maxH 안에 비율을 지켜 맞춘다. maxScale을 넘겨 키우지 않는다. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number, maxScale = 1): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(maxW / w, maxH / h, maxScale);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 팝업용 작은 미리보기. 원본(업로드용)은 그대로 두고 줄인 사본만 WebP로 만든다. */
export async function makeThumbnail(image: Blob, maxW = 672, maxH = 480): Promise<Thumb> {
  const bitmap = await createImageBitmap(image);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxW, maxH);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    if (blob.type !== "image/webp") blob = await canvas.convertToBlob({ type: "image/png" });
    return { base64: toBase64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type, sourceWidth: bitmap.width, sourceHeight: bitmap.height };
  } finally {
    bitmap.close();
  }
}
