import { z } from "zod";
import { SessionSnapshot } from "./session.ts";

/** 추천 근거. UI 문구는 docs/UX.md §6. */
export const ReasonTag = z.enum(["source-match", "dev-server", "recent-edit", "topic", "previous-choice"]);
export type ReasonTag = z.infer<typeof ReasonTag>;

export const Recommendation = z.object({
  sessionKey: z.string(),
  rank: z.number().int().min(1),
  score: z.number(),
  confidence: z.enum(["high", "medium", "low"]),
  reasons: z.array(ReasonTag),
  method: z.enum(["heuristic", "llm"]),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const DispatchState = z.enum(["queued", "delivering", "delivered", "working", "done", "failed", "cancelled"]);
export type DispatchState = z.infer<typeof DispatchState>;

export const FINAL_DISPATCH_STATES: readonly DispatchState[] = ["done", "failed", "cancelled"];

/** 예약(queued) 상태에서 기다리는 이유. */
/** paste: VS Code 세션 — 프롬프트를 복사해 두었고 사용자가 붙여 넣기를 기다림. */
export const WaitReason = z.enum(["busy", "waiting", "input", "unknown-screen", "gone", "paste"]);
export type WaitReason = z.infer<typeof WaitReason>;

export const DispatchMode = z.enum(["wait-idle", "now"]);
export type DispatchMode = z.infer<typeof DispatchMode>;

export const Dispatch = z.object({
  id: z.number().int(),
  requestId: z.number().int(),
  sessionKey: z.string(),
  sessionName: z.string(),
  paneId: z.string().nullable(),
  mode: DispatchMode,
  state: DispatchState,
  waitReason: WaitReason.nullable(),
  /** 붙여 넣은 프롬프트의 마커. 예: "[switchboard #42]". */
  marker: z.string(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  /** 완료 시 Claude 마지막 응답 앞부분. */
  summary: z.string().nullable(),
  /** 완료 시 Claude 최종 답변 전체(마크다운). 목록 응답에서는 빠진다. */
  reply: z.string().nullable().optional(),
});
export type Dispatch = z.infer<typeof Dispatch>;

export const PairBody = z.object({
  code: z.string().min(6).max(12),
  label: z.string().max(64).optional(),
});
export type PairBody = z.infer<typeof PairBody>;

/** 연계 대상: 같은 요청에 덧붙인 다른 캡처들(대상 2, 3, …). */
export const ExtraCaptureIds = z.array(z.string()).max(7).default([]);

/** 프롬프트·맥락 문서의 언어. 확장은 화면 언어를 보낸다. 없으면 데몬 설정(language). */
export const PromptLang = z.enum(["en", "ko"]);
export type PromptLang = z.infer<typeof PromptLang>;

export const PreviewBody = z.object({
  lang: PromptLang.optional(),
  captureId: z.string(),
  extraCaptureIds: ExtraCaptureIds,
  text: z.string().max(8000),
  sessionKey: z.string().optional(),
});
export type PreviewBody = z.infer<typeof PreviewBody>;

export const RecommendBody = z.object({
  captureId: z.string(),
  text: z.string().max(8000).default(""),
});
export type RecommendBody = z.infer<typeof RecommendBody>;

export const CreateRequestBody = z.object({
  lang: PromptLang.optional(),
  captureId: z.string(),
  extraCaptureIds: ExtraCaptureIds,
  text: z.string().min(1).max(8000),
  /** 전달할 세션. 없으면 저장만 한다. */
  sessionKey: z.string().optional(),
  mode: DispatchMode.default("wait-idle"),
});
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

/** 완료된 요청에 이어서 같은 세션으로 보낸다. 연계 대상을 덧붙일 수 있다. */
export const FollowUpBody = z.object({
  lang: PromptLang.optional(),
  text: z.string().min(1).max(8000),
  extraCaptureIds: ExtraCaptureIds,
  mode: DispatchMode.default("wait-idle"),
});
export type FollowUpBody = z.infer<typeof FollowUpBody>;

export const DispatchRequestBody = z.object({
  sessionKey: z.string().optional(),
  mode: DispatchMode.default("wait-idle"),
});
export type DispatchRequestBody = z.infer<typeof DispatchRequestBody>;

export const RequestInfo = z.object({
  id: z.number().int(),
  captureId: z.string(),
  /** 대상 전부(첫째가 captureId). */
  captureIds: z.array(z.string()),
  /** 이어서 쓴 요청이면 앞 요청 번호. */
  parentId: z.number().int().nullable(),
  sessionKey: z.string().nullable(),
  text: z.string(),
  url: z.string(),
  prompt: z.string(),
  contextFile: z.string(),
  createdAt: z.number(),
  /** 가장 최근 전달 시도. 저장만 했으면 null. */
  dispatch: Dispatch.nullable(),
});
export type RequestInfo = z.infer<typeof RequestInfo>;

/** SSE 이벤트. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sessions.updated"), snapshot: SessionSnapshot }),
  z.object({ type: z.literal("dispatch.updated"), dispatch: Dispatch }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
