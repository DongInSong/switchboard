import type { Dispatch, Recommendation, RequestInfo, SessionSnapshot } from "@switchboard/protocol";
import { toBase64 } from "./crop.ts";
import type { DaemonError, Result } from "./messages.ts";
import { getLang } from "./i18n.ts";
import { DEFAULT_BASE } from "./origins.ts";

/** 백그라운드에서만 쓴다. 데몬과의 통신은 전부 여기를 거친다. */

const TOKEN_KEY = "sb:token";
const BASE_KEY = "sb:base";

async function settings(): Promise<{ base: string; token?: string }> {
  const s = (await browser.storage.local.get([TOKEN_KEY, BASE_KEY])) as Record<string, unknown>;
  const token = typeof s[TOKEN_KEY] === "string" ? (s[TOKEN_KEY] as string) : undefined;
  const base = typeof s[BASE_KEY] === "string" ? (s[BASE_KEY] as string) : DEFAULT_BASE;
  return token ? { base, token } : { base };
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Result<T>> {
  const { base, token } = await settings();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, error: "disconnected" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (res.ok) return { ok: true, data: body as T };
  const error = (body as { error?: string } | null)?.error ?? `http-${res.status}`;
  return { ok: false, error: error as DaemonError };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function status(): Promise<Result<{ paired: boolean; version: string }>> {
  const health = await call<{ version: string }>("/v1/health");
  if (!health.ok) return health;
  const me = await call<{ ok: boolean }>("/v1/me");
  if (me.ok) return { ok: true, data: { paired: true, version: health.data.version } };
  if (me.error === "unauthorized") return { ok: true, data: { paired: false, version: health.data.version } };
  return me;
}

export const sessions = (fresh = false) => call<SessionSnapshot>(fresh ? "/v1/sessions?refresh=1" : "/v1/sessions");

export async function pair(code: string): Promise<Result<null>> {
  const res = await call<{ token: string }>("/v1/pair", json({ code, label: "edge" }));
  if (!res.ok) return res;
  await browser.storage.local.set({ [TOKEN_KEY]: res.data.token });
  return { ok: true, data: null };
}

export const preview = (captureId: string, text: string, sessionKey?: string, extraCaptureIds: string[] = []) =>
  call<{ prompt: string }>("/v1/preview", json({ captureId, extraCaptureIds, text, lang: getLang(), ...(sessionKey ? { sessionKey } : {}) }));

export const recommend = (captureId: string, text: string) => call<{ recommendations: Recommendation[] }>("/v1/recommend", json({ captureId, text }));

export const createRequest = (captureId: string, text: string, sessionKey?: string, extraCaptureIds: string[] = []) =>
  call<RequestInfo>("/v1/requests", json({ captureId, extraCaptureIds, text, lang: getLang(), ...(sessionKey ? { sessionKey } : {}) }));

export const getRequest = (id: number) => call<RequestInfo>(`/v1/requests/${id}`);

export const followUp = (id: number, text: string, extraCaptureIds: string[] = []) =>
  call<RequestInfo>(`/v1/requests/${id}/followup`, json({ text, extraCaptureIds, lang: getLang() }));

export const listRequests = () => call<RequestInfo[]>("/v1/requests?limit=30");

export const cancelDispatch = (id: number) => call<Dispatch>(`/v1/dispatches/${id}/cancel`, { method: "POST" });

/** 기록 썸네일: 데몬에 저장된 잘라 낸 스크린샷. */
export async function captureImage(captureId: string): Promise<Result<{ base64: string; mime: string }>> {
  const { base, token } = await settings();
  try {
    const res = await fetch(`${base}/v1/captures/${encodeURIComponent(captureId)}/element.png`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { ok: false, error: "unauthorized" };
    if (!res.ok) return { ok: false, error: res.status === 404 ? "not-found" : `http-${res.status}` };
    return { ok: true, data: { base64: toBase64(new Uint8Array(await res.arrayBuffer())), mime: "image/png" } };
  } catch {
    return { ok: false, error: "disconnected" };
  }
}

export function uploadCapture(form: FormData): Promise<Result<{ id: string; recommendations: Recommendation[] }>> {
  return call<{ id: string; recommendations: Recommendation[] }>("/v1/captures", { method: "POST", body: form }, 30_000);
}
