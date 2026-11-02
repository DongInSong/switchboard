import { z } from "zod";

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof Rect>;

export const Viewport = z.object({
  width: z.number(),
  height: z.number(),
  dpr: z.number(),
  scrollX: z.number(),
  scrollY: z.number(),
});
export type Viewport = z.infer<typeof Viewport>;

export const ElementInfo = z.object({
  selector: z.string(),
  tag: z.string(),
  id: z.string().optional(),
  classes: z.array(z.string()),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  testId: z.string().optional(),
  /** 300자 이내. */
  text: z.string().max(300),
  /** 4KB 이내, input 값과 password 제거. */
  outerHTML: z.string().max(4096),
  styles: z.record(z.string(), z.string()),
  rect: Rect,
});
export type ElementInfo = z.infer<typeof ElementInfo>;

export const SourceHint = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  /** 줄 번호가 변환된 코드 기준이라 원본과 어긋날 수 있음(소스맵 미적용). */
  lineApprox: z.boolean().optional(),
  framework: z.enum(["react", "vue", "svelte", "marker", "unknown"]),
  /** 찾은 방법. 예: "data-tsd-source", "react-owner-stack". */
  via: z.string(),
  componentStack: z
    .array(
      z.object({
        name: z.string(),
        file: z.string().optional(),
        line: z.number().int().optional(),
      }),
    )
    .optional(),
});
export type SourceHint = z.infer<typeof SourceHint>;

export const Capture = z.object({
  url: z.string(),
  title: z.string(),
  capturedAt: z.number(),
  viewport: Viewport,
  selection: z.object({
    mode: z.enum(["element", "region"]),
    rect: Rect,
    primary: ElementInfo,
    others: z.array(ElementInfo),
  }),
  source: z.array(SourceHint),
  /** multipart 파트 이름. */
  screenshots: z.object({
    element: z.string(),
    viewport: z.string(),
  }),
});
export type Capture = z.infer<typeof Capture>;
