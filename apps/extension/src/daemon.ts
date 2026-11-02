import type { Dispatch, Recommendation, RequestInfo, SessionSnapshot } from "@switchboard/protocol";
import { toBase64 } from "./crop.ts";
import type { DaemonError, Result } from "./messages.ts";
import { getLang } from "./i18n.ts";
import { native } from "./native.ts";
import { DEFAULT_BASE } from "./origins.ts";

/**
 * 백그라운드에서만 쓴다. 데몬과의 통신은 전부 여기를 거친다.
 * 통로: Native Messaging(호스트가 등록돼 있으면, 페어링 없음) → 안 되면 HTTP(127.0.0.1, 페어링 토큰).
 */

export type Transport = "native" | "http";
type Raw = { status: number; contentType: string; text?: string; bytes?: Uint8Array; via: Transport };

const TOKEN_KEY = "sb:token";
const BASE_KEY = "sb:base";

async function settings(): Promise<{ base: string; token?: string }> {
  const s = (await browser.storage.local.get([TOKEN_KEY, BASE_KEY])) as Record<string, unknown>;
  const token = typeof s[TOKEN_KEY] === "string" ? (s[TOKEN_KEY] as string) : undefined;
  const base = typeof s[BASE_KEY] === "string" ? (s[BASE_KEY] as string) : DEFAULT_BASE;
  return token ? { base, token } : { base };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 네이티브로 보낼 수 있게 요청 본문을 글자나 base64로. FormData는 multipart 바이트로 만든다. */
async function encodeBody(init: RequestInit): Promise<{ contentType?: string; body?: string; bodyB64?: string }> {
  if (init.body === undefined || init.body === null) return {};
  if (typeof init.body === "string") return { contentType: new Headers(init.headers).get("content-type") ?? "text/plain", body: init.body };
  const req = new Request("http://switchboard.invalid/", { method: "POST", body: init.body as BodyInit });
  return { contentType: req.headers.get("content-type") ?? "application/octet-stream", bodyB64: toBase64(new Uint8Array(await req.arrayBuffer())) };
}

/** 한 번 보내기. 둘 다 안 되면 null(연결 끊김). */
async function send(path: string, init: RequestInit, timeoutMs: number): Promise<Raw | null> {
  if (!native.resting) {
    try {
      // 첫 요청은 호스트가 데몬을 켜는 시간이 들 수 있다
      const r = await native.request({ type: "http", method: init.method ?? "GET", path, ...(await encodeBody(init)) }, timeoutMs + 12_000);
      return { status: r.status, contentType: r.contentType, via: "native", ...(r.body !== undefined ? { text: r.body } : {}), ...(r.bodyB64 !== undefined ? { bytes: fromBase64(r.bodyB64) } : {}) };
    } catch {
      /* 호스트 없음 → HTTP */
    }
  }
  const { base, token } = await settings();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const contentType = res.headers.get("content-type") ?? "";
    if (/^(application\/json|text\/)/.test(contentType)) return { status: res.status, contentType, text: await res.text(), via: "http" };
    return { status: res.status, contentType, bytes: new Uint8Array(await res.arrayBuffer()), via: "http" };
  } catch {
    return null;
  }
}

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Result<T>> {
  const res = await send(path, init, timeoutMs);
  if (!res) return { ok: false, error: "disconnected" };
  let body: unknown = null;
  try {
    body = res.text ? JSON.parse(res.text) : null;
  } catch {
    /* 본문 없음 */
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, data: body as T };
  const error = (body as { error?: string } | null)?.error ?? `http-${res.status}`;
  return { ok: false, error: error as DaemonError };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function status(): Promise<Result<{ paired: boolean; version: string; transport: Transport }>> {
  if (!native.resting) {
    try {
      const hello = await native.request({ type: "hello" }, 20_000);
      if (hello.status === 200) return { ok: true, data: { paired: true, version: hello.version ?? "", transport: "native" } };
    } catch {
      /* HTTP로 */
    }
  }
  const health = await call<{ version: string }>("/v1/health");
  if (!health.ok) return health;
  const me = await call<{ ok: boolean }>("/v1/me");
  if (me.ok) return { ok: true, data: { paired: true, version: health.data.version, transport: "http" } };
  if (me.error === "unauthorized") return { ok: true, data: { paired: false, version: health.data.version, transport: "http" } };
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
  const res = await send(`/v1/captures/${encodeURIComponent(captureId)}/element.png`, {}, 10_000);
  if (!res) return { ok: false, error: "disconnected" };
  if (res.status === 401) return { ok: false, error: "unauthorized" };
  if (res.status < 200 || res.status >= 300 || !res.bytes) return { ok: false, error: res.status === 404 ? "not-found" : `http-${res.status}` };
  return { ok: true, data: { base64: toBase64(res.bytes), mime: "image/png" } };
}

export function uploadCapture(form: FormData): Promise<Result<{ id: string; recommendations: Recommendation[] }>> {
  return call<{ id: string; recommendations: Recommendation[] }>("/v1/captures", { method: "POST", body: form }, 30_000);
}
