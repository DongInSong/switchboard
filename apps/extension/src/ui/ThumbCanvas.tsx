import { useEffect, useRef } from "react";
import { fitWithin, fromBase64, type Thumb } from "../crop.ts";

/**
 * 미리보기를 canvas에 그린다. 페이지의 CSP가 data:/blob: 이미지를 막아도 canvas 그리기는 막지 못한다.
 * maxScale: 작은 요소를 키워 보여 줄 최대 배율.
 */
export function ThumbCanvas({ thumb, maxW, maxH, maxScale = 1, className }: { thumb: Thumb; maxW: number; maxH: number; maxScale?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bitmap = await createImageBitmap(new Blob([fromBase64(thumb.base64)], { type: thumb.mime }));
      const canvas = ref.current;
      if (cancelled || !canvas) {
        bitmap.close();
        return;
      }
      // 원본 크기(장치 픽셀)를 CSS 픽셀로 환산해 같은 탭의 배율로 그린다
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = fitWithin(thumb.sourceWidth / dpr, thumb.sourceHeight / dpr, maxW, maxH, maxScale);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      }
      bitmap.close();
    })();
    return () => {
      cancelled = true;
    };
  }, [thumb, maxW, maxH, maxScale]);
  // 그리기 전에는 0 크기(기본 300×150 빈 상자가 깜빡이지 않게)
  return <canvas ref={ref} className={className} width={0} height={0} />;
}
