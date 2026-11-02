import type { Capture, Dispatch, Rect, Recommendation, RequestInfo, SessionSnapshot } from "@switchboard/protocol";
import type { Thumb } from "./crop.ts";
import type { DraftSummary } from "./drafts.ts";
import type { Chip, Composing, Link } from "./overlay/store.ts";

/** 캡처 초안: 스크린샷 파트 이름은 백그라운드가 채운다. */
export type CaptureDraft = Omit<Capture, "screenshots">;

export type DaemonError = "disconnected" | "unauthorized" | "no-code" | "expired" | "invalid" | "locked" | "capture-failed" | (string & {});

export type Result<T> = { ok: true; data: T } | { ok: false; error: DaemonError };

/** 오버레이·사이드 패널 → 백그라운드 */
export type Request =
  | { type: "capture/shoot"; rect: Rect; viewport: { width: number; height: number } }
  | { type: "capture/upload"; shotId: string; capture: CaptureDraft }
  | { type: "daemon/status" }
  | { type: "daemon/sessions"; fresh?: boolean }
  | { type: "daemon/pair"; code: string }
  | { type: "daemon/preview"; captureId: string; extraCaptureIds?: string[]; text: string; sessionKey?: string }
  | { type: "daemon/recommend"; captureId: string; text: string }
  | { type: "daemon/request"; captureId: string; extraCaptureIds?: string[]; text: string; sessionKey?: string }
  | { type: "daemon/request-get"; id: number }
  | { type: "daemon/requests" }
  | { type: "daemon/cancel"; dispatchId: number }
  | { type: "daemon/capture-image"; captureId: string }
  | { type: "daemon/followup"; id: number; text: string; extraCaptureIds?: string[] }
  | { type: "drafts/sync"; scope: string[]; popovers: Composing[]; chips: Chip[] }
  | { type: "drafts/restore"; url: string }
  | { type: "drafts/others"; url: string }
  | { type: "drafts/link"; targetId: string; links: Link[] }
  | { type: "attach/arm"; draftId: string; url: string }
  | { type: "attach/disarm" }
  | { type: "panel/open" }
  | { type: "e2e/start-pick"; tabId: number };

export type ResponseOf<R extends Request> = R extends { type: "capture/shoot" }
  ? Result<{ shotId: string; thumbnail: Thumb | null }>
  : R extends { type: "capture/upload" }
    ? Result<{ captureId: string; recommendations: Recommendation[] }>
    : R extends { type: "daemon/status" }
      ? Result<{ paired: boolean; version: string; transport: "native" | "http"; nativeError?: string }>
      : R extends { type: "daemon/sessions" }
        ? Result<SessionSnapshot>
        : R extends { type: "daemon/pair" }
          ? Result<null>
          : R extends { type: "daemon/preview" }
            ? Result<{ prompt: string }>
            : R extends { type: "daemon/request" | "daemon/request-get" | "daemon/followup" }
              ? Result<RequestInfo>
              : R extends { type: "daemon/recommend" }
                ? Result<{ recommendations: Recommendation[] }>
                : R extends { type: "daemon/requests" }
                  ? Result<RequestInfo[]>
                  : R extends { type: "daemon/cancel" }
                    ? Result<Dispatch>
                    : R extends { type: "daemon/capture-image" }
                      ? Result<{ base64: string; mime: string }>
                      : R extends { type: "drafts/restore" }
                        ? Result<{ popovers: Composing[]; chips: Chip[] }>
                        : R extends { type: "drafts/others" }
                          ? Result<DraftSummary[]>
                          : Result<null>;

/** 백그라운드 → 오버레이 */
export type ContentMessage =
  /** attachTo: 다른 페이지·탭의 요청에 덧붙이는 선택(연계 대기 중일 때) */
  | { type: "pick/start"; attachTo?: { draftId: string; name: string } }
  /** 다른 곳에서 이 페이지의 요청에 대상이 붙었다 */
  | { type: "draft/linked"; draftId: string; links: Link[] }
  /** 연계가 다른 페이지에서 끝났으니 이 페이지의 선택 도구를 내린다 */
  | { type: "pick/cancel"; draftId: string };

export async function send<R extends Request>(req: R): Promise<ResponseOf<R>> {
  try {
    const res = (await browser.runtime.sendMessage(req)) as ResponseOf<R> | undefined;
    return res ?? ({ ok: false, error: "no-response" } as ResponseOf<R>);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) } as ResponseOf<R>;
  }
}
