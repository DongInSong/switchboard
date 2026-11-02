import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  Capture,
  CreateRequestBody,
  DispatchRequestBody,
  FINAL_DISPATCH_STATES,
  FollowUpBody,
  PairBody,
  PreviewBody,
  type PromptLang,
  RecommendBody,
  type Dispatch,
  type DispatchMode,
  type Recommendation,
  type RequestInfo,
  type Session,
  type SessionSnapshot,
} from "@switchboard/protocol";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Auth } from "./auth.ts";
import { composeContext, composePrompt, withLine, type ComposeInput } from "./compose.ts";
import { VERSION, type Paths } from "./config.ts";
import { ContextService, displayPath } from "./context.ts";
import type { CaptureRow, RequestRow, Store } from "./store.ts";

export type RegistryLike = {
  readonly snapshot: SessionSnapshot | null;
  refresh(): Promise<SessionSnapshot>;
  on(event: "change", fn: (s: SessionSnapshot) => void): unknown;
  off(event: "change", fn: (s: SessionSnapshot) => void): unknown;
};

export type DispatcherLike = {
  enqueue(requestId: number, session: Session, mode: DispatchMode, marker: string): Dispatch;
  cancel(id: number): Dispatch | null;
};

export type AppDeps = {
  auth: Auth;
  store: Store;
  registry: RegistryLike;
  paths: Paths;
  port: number;
  /** 없으면 활동 정보 없이 레지스트리만 쓴다. */
  context?: ContextService;
  /** 없으면 요청을 저장만 한다. */
  dispatcher?: DispatcherLike | null;
  /** "dispatch" 이벤트를 SSE로 내보낸다. */
  bus?: EventEmitter | null;
  now?: () => number;
  /** SSE 하트비트 간격. 테스트에서 줄인다. */
  heartbeatMs?: number;
  /** 확장이 lang을 안 보냈을 때 프롬프트 언어(설정 language). */
  lang?: PromptLang;
  /** 토큰이 필요한 요청마다(무활동 종료 판단). */
  onActivity?: () => void;
};

/** 브라우저 확장 오리진만 허용한다. 웹 페이지(http/https)와 sandbox iframe("null")은 거부. */
const EXTENSION_ORIGIN = /^(chrome-extension|extension|moz-extension|safari-web-extension):\/\/[^/]+$/i;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

export function newCaptureId(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export const markerFor = (requestId: number) => `[switchboard #${requestId}]`;

function isInside(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p.startsWith(r + sep);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function bearer(c: Context): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createApp(d: AppDeps): Hono {
  const now = d.now ?? Date.now;
  const context = d.context ?? new ContextService({ registry: d.registry, activity: null });
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${d.port}`, `localhost:${d.port}`]);

  const requestInfo = (r: RequestRow): RequestInfo => ({
    id: r.id,
    captureId: r.captureId,
    captureIds: r.captureIds,
    parentId: r.parentId,
    sessionKey: r.sessionKey,
    text: r.text,
    url: d.store.getCapture(r.captureId)?.url ?? "",
    prompt: r.prompt,
    contextFile: r.contextFile,
    createdAt: r.createdAt,
    dispatch: d.store.latestDispatch(r.id),
  });

  /** 세션 기준 상대 경로로 소스 위치를 표시한다. extras는 연계 대상(대상 2, 3, …). */
  const defaultLang: PromptLang = d.lang ?? "en";
  const composeFor = async (row: CaptureRow, requestId: number, text: string, session: Session | undefined, extras: readonly CaptureRow[], lang: PromptLang): Promise<ComposeInput> => {
    const snap = await context.sessions();
    const display = async (r: CaptureRow) => {
      const analysis = await context.analyze(r.id, r.capture, snap.sessions);
      return analysis.sourceFile ? withLine(displayPath(analysis.sourceFile, session?.cwd), r.capture.source[0]) : undefined;
    };
    return {
      marker: markerFor(requestId),
      lang,
      text,
      capture: row.capture,
      elementPng: join(row.dir, "element.png"),
      viewportPng: join(row.dir, "viewport.png"),
      contextFile: join(row.dir, `context-${requestId}.md`),
      sourceDisplay: await display(row),
      extras: await Promise.all(
        extras.map(async (r) => ({ capture: r.capture, elementPng: join(r.dir, "element.png"), viewportPng: join(r.dir, "viewport.png"), sourceDisplay: await display(r) })),
      ),
    };
  };

  /** 연계 대상 캡처들. 대표와 겹치거나 중복이면 뺀다. 없는 것이 있으면 null. */
  const extraRows = (primaryId: string, ids: readonly string[]): CaptureRow[] | null => {
    const rows: CaptureRow[] = [];
    for (const id of new Set(ids)) {
      if (id === primaryId) continue;
      const r = d.store.getCapture(id);
      if (!r) return null;
      rows.push(r);
    }
    return rows;
  };

  const recommendFor = async (row: CaptureRow, text: string): Promise<Recommendation[]> => {
    try {
      return (await context.recommend(row.id, row.capture, text, d.store.lastSessionForOrigin(row.origin))).recommendations;
    } catch (e) {
      process.stderr.write(`! recommend: ${e instanceof Error ? e.message : String(e)}\n`);
      return [];
    }
  };

  const findSession = async (key: string): Promise<Session | undefined> => (await context.sessions(true)).sessions.find((s) => s.key === key);

  // 1) DNS 리바인딩 방어: Host가 우리 주소가 아니면 거부. 2) 웹 오리진 거부.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!allowedHosts.has(host)) return c.json({ error: "forbidden-host" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) return c.json({ error: "forbidden-origin" }, 403);
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 24 * 1024 * 1024, onError: (c) => c.json({ error: "too-large" }, 413) }));

  app.get("/v1/health", (c) => c.json({ name: "switchboard", version: VERSION }));

  app.post("/v1/pair", async (c) => {
    const body = PairBody.safeParse(await readJsonBody(c));
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const res = await d.auth.redeem(body.data.code, body.data.label);
    if (!res.ok) return c.json({ error: res.error }, res.error === "locked" ? 429 : 401);
    return c.json({ token: res.token });
  });

  // 여기부터는 토큰 필요.
  app.use("/v1/*", async (c, next) => {
    if (!(await d.auth.verify(bearer(c)))) return c.json({ error: "unauthorized" }, 401);
    d.onActivity?.();
    await next();
  });

  app.get("/v1/me", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/v1/sessions", async (c) => c.json(await context.sessions(c.req.query("refresh") === "1")));

  app.get("/v1/events", (c) =>
    streamSSE(c, async (stream) => {
      const sendSessions = (snapshot: SessionSnapshot) =>
        stream.writeSSE({ event: "sessions.updated", data: JSON.stringify({ type: "sessions.updated", snapshot }) });
      const onChange = (s: SessionSnapshot) => void sendSessions(s).catch(() => undefined);
      const onDispatch = (dispatch: Dispatch) =>
        void stream.writeSSE({ event: "dispatch.updated", data: JSON.stringify({ type: "dispatch.updated", dispatch }) }).catch(() => undefined);
      d.registry.on("change", onChange);
      d.bus?.on("dispatch", onDispatch);
      const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined), d.heartbeatMs ?? 25_000);
      try {
        await sendSessions(d.registry.snapshot ?? (await d.registry.refresh()));
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        clearInterval(heartbeat);
        d.registry.off("change", onChange);
        d.bus?.off("dispatch", onDispatch);
      }
    }),
  );

  app.post("/v1/captures", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.json({ error: "bad-multipart" }, 400);
    }
    let json: unknown = null;
    try {
      json = typeof form.capture === "string" ? JSON.parse(form.capture) : null;
    } catch {
      /* 아래에서 거부 */
    }
    const parsed = Capture.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "bad-capture", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    }
    const capture = parsed.data;
    const images: Record<"element" | "viewport", Uint8Array> = { element: new Uint8Array(), viewport: new Uint8Array() };
    for (const key of ["element", "viewport"] as const) {
      const part = form[capture.screenshots[key]];
      if (!(part instanceof File)) return c.json({ error: `missing-${key}` }, 400);
      if (part.size > MAX_IMAGE_BYTES) return c.json({ error: `${key}-too-large` }, 413);
      const bytes = new Uint8Array(await part.arrayBuffer());
      if (!isPng(bytes)) return c.json({ error: `${key}-not-png` }, 400);
      images[key] = bytes;
    }
    const createdAt = now();
    const id = newCaptureId(createdAt);
    const dir = join(d.paths.capturesDir, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(dir, "element.png"), images.element),
      writeFile(join(dir, "viewport.png"), images.viewport),
      writeFile(join(dir, "capture.json"), JSON.stringify(capture, null, 2)),
    ]);
    const row: CaptureRow = { id, createdAt, url: capture.url, origin: originOf(capture.url), title: capture.title, dir, capture };
    d.store.insertCapture(row);
    return c.json({ id, dir, recommendations: await recommendFor(row, "") }, 201);
  });

  /** 저장된 스크린샷(기록 썸네일). 캡처 폴더 안의 두 파일만 내준다. */
  app.get("/v1/captures/:id/:name", async (c) => {
    const name = c.req.param("name");
    if (name !== "element.png" && name !== "viewport.png") return c.json({ error: "not-found" }, 404);
    const row = d.store.getCapture(c.req.param("id"));
    if (!row || !isInside(row.dir, d.paths.capturesDir)) return c.json({ error: "not-found" }, 404);
    try {
      const bytes = await readFile(join(row.dir, name));
      return c.body(bytes, 200, { "content-type": "image/png", "cache-control": "private, max-age=3600" });
    } catch {
      return c.json({ error: "not-found" }, 404);
    }
  });

  app.post("/v1/recommend", async (c) => {
    const body = RecommendBody.safeParse(await readJsonBody(c));
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const row = d.store.getCapture(body.data.captureId);
    if (!row) return c.json({ error: "capture-not-found" }, 404);
    return c.json({ recommendations: await recommendFor(row, body.data.text) });
  });

  app.post("/v1/preview", async (c) => {
    const body = PreviewBody.safeParse(await readJsonBody(c));
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const row = d.store.getCapture(body.data.captureId);
    const extras = row ? extraRows(row.id, body.data.extraCaptureIds) : null;
    if (!row || !extras) return c.json({ error: "capture-not-found" }, 404);
    const session = body.data.sessionKey ? (await context.sessions()).sessions.find((s) => s.key === body.data.sessionKey) : undefined;
    const input = await composeFor(row, d.store.nextRequestId(), body.data.text, session, extras, body.data.lang ?? defaultLang);
    return c.json({ prompt: composePrompt(input) });
  });

  app.post("/v1/requests", async (c) => {
    const body = CreateRequestBody.safeParse(await readJsonBody(c));
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const row = d.store.getCapture(body.data.captureId);
    const extras = row ? extraRows(row.id, body.data.extraCaptureIds) : null;
    if (!row || !extras) return c.json({ error: "capture-not-found" }, 404);
    let session: Session | undefined;
    if (body.data.sessionKey) {
      session = await findSession(body.data.sessionKey);
      if (!session) return c.json({ error: "session-gone" }, 409);
      if (!session.dispatchable) return c.json({ error: "not-dispatchable" }, 409);
    }
    const lang = body.data.lang ?? defaultLang;
    const id = d.store.reserveRequest(row.id, body.data.text, session?.key ?? null, now(), extras.map((r) => r.id), null, lang);
    const input = await composeFor(row, id, body.data.text, session, extras, lang);
    await writeFile(input.contextFile, composeContext(input));
    d.store.fillRequest(id, composePrompt(input), input.contextFile);
    if (session && d.dispatcher) d.dispatcher.enqueue(id, session, body.data.mode, markerFor(id));
    return c.json(requestInfo(d.store.getRequest(id)!), 201);
  });

  app.get("/v1/requests", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 30));
    // 목록은 3초마다 불리므로 전체 답변은 빼고 보낸다(상세 조회에서 받음).
    return c.json(d.store.listRequests(limit).map((r) => {
      const info = requestInfo(r);
      return info.dispatch ? { ...info, dispatch: { ...info.dispatch, reply: undefined } } : info;
    }));
  });

  /** 완료된 요청에 이어서 같은 세션으로. 새 대상이 없으면 "#N에 이어서" 한 줄만 붙인다. */
  app.post("/v1/requests/:id/followup", async (c) => {
    if (!d.dispatcher) return c.json({ error: "dispatch-disabled" }, 503);
    const body = FollowUpBody.safeParse(await readJsonBody(c));
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const parent = d.store.getRequest(Number(c.req.param("id")));
    if (!parent) return c.json({ error: "not-found" }, 404);
    if (!parent.sessionKey) return c.json({ error: "no-session" }, 400);
    const session = await findSession(parent.sessionKey);
    if (!session) return c.json({ error: "session-gone" }, 409);
    if (!session.dispatchable) return c.json({ error: "not-dispatchable" }, 409);
    const added = body.data.extraCaptureIds;
    const primary = d.store.getCapture(added[0] ?? parent.captureId);
    const extras = primary ? extraRows(primary.id, added.slice(1)) : null;
    if (!primary || !extras) return c.json({ error: "capture-not-found" }, 404);
    const lang = body.data.lang ?? parent.lang ?? defaultLang;
    const id = d.store.reserveRequest(primary.id, body.data.text, session.key, now(), extras.map((r) => r.id), parent.id, lang);
    const input = { ...(await composeFor(primary, id, body.data.text, session, extras, lang)), followUpOf: parent.id, omitTargets: added.length === 0 };
    await writeFile(input.contextFile, composeContext(input));
    d.store.fillRequest(id, composePrompt(input), input.contextFile);
    d.dispatcher.enqueue(id, session, body.data.mode, markerFor(id));
    return c.json(requestInfo(d.store.getRequest(id)!), 201);
  });

  app.get("/v1/requests/:id", (c) => {
    const r = d.store.getRequest(Number(c.req.param("id")));
    return r ? c.json(requestInfo(r)) : c.json({ error: "not-found" }, 404);
  });

  /** 이미 저장된 요청을 (다시) 보낸다. 프롬프트는 보낼 세션 기준으로 지금 다시 쓴다(경로·형식 최신화). */
  app.post("/v1/requests/:id/dispatch", async (c) => {
    if (!d.dispatcher) return c.json({ error: "dispatch-disabled" }, 503);
    const body = DispatchRequestBody.safeParse((await readJsonBody(c)) ?? {});
    if (!body.success) return c.json({ error: "bad-request" }, 400);
    const req = d.store.getRequest(Number(c.req.param("id")));
    if (!req) return c.json({ error: "not-found" }, 404);
    const active = d.store.latestDispatch(req.id);
    if (active && !FINAL_DISPATCH_STATES.includes(active.state)) return c.json({ error: "already-active", dispatch: active }, 409);
    const key = body.data.sessionKey ?? req.sessionKey;
    if (!key) return c.json({ error: "no-session" }, 400);
    const session = await findSession(key);
    if (!session) return c.json({ error: "session-gone" }, 409);
    if (!session.dispatchable) return c.json({ error: "not-dispatchable" }, 409);
    const row = d.store.getCapture(req.captureId);
    const extras = row ? (extraRows(row.id, req.captureIds) ?? []) : [];
    if (row) {
      const input = await composeFor(row, req.id, req.text, session, extras, req.lang ?? defaultLang);
      await writeFile(input.contextFile, composeContext(input));
      d.store.fillRequest(req.id, composePrompt(input), input.contextFile);
    }
    if (session.key !== req.sessionKey) d.store.setRequestSession(req.id, session.key);
    d.dispatcher.enqueue(req.id, session, body.data.mode, markerFor(req.id));
    return c.json(requestInfo(d.store.getRequest(req.id)!), 202);
  });

  app.post("/v1/dispatches/:id/cancel", (c) => {
    if (!d.dispatcher) return c.json({ error: "dispatch-disabled" }, 503);
    const res = d.dispatcher.cancel(Number(c.req.param("id")));
    if (!res) return c.json({ error: "not-found" }, 404);
    return res.state === "cancelled" ? c.json(res) : c.json({ error: "not-cancellable", dispatch: res }, 409);
  });

  app.notFound((c) => c.json({ error: "not-found" }, 404));
  app.onError((err, c) => {
    process.stderr.write(`! ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}\n`);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
