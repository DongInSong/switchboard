import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capture, SessionSnapshot } from "@switchboard/protocol";
import { sampleCapture } from "./testing/fixtures.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth } from "./auth.ts";
import { pathsFrom, type Paths } from "./config.ts";
import { ContextService } from "./context.ts";
import { createApp, type RegistryLike } from "./server.ts";
import { Store } from "./store.ts";

const PORT = 7490;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class FakeRegistry extends EventEmitter implements RegistryLike {
  snapshot: SessionSnapshot | null = null;
  next: SessionSnapshot = { sessions: [], takenAt: 1, tmuxRunning: true, warnings: [] };
  async refresh() {
    this.snapshot = this.next;
    return this.next;
  }
}

let dir: string;
let paths: Paths;
let store: Store;
let auth: Auth;
let registry: FakeRegistry;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-test-"));
  paths = pathsFrom(join(dir, "state"), join(dir, "data"));
  store = new Store(":memory:");
  auth = new Auth({ pairFile: paths.pairFile, tokensFile: paths.tokensFile });
  registry = new FakeRegistry();
  // 실제 ss 조회는 이 머신에서 도는 dev 서버를 찾아내므로 테스트에서는 끈다.
  const context = new ContextService({ registry, activity: null, portOwner: async () => null });
  app = createApp({ auth, store, registry, paths, port: PORT, heartbeatMs: 50, context, lang: "ko" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function pairToken(): Promise<string> {
  const { code } = await auth.createPairCode();
  const res = await app.request(`${BASE}/v1/pair`, { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } };
}

function captureForm(capture: Capture, element: Uint8Array<ArrayBuffer> = PNG, viewport: Uint8Array<ArrayBuffer> = PNG): FormData {
  const form = new FormData();
  form.set("capture", JSON.stringify(capture));
  form.set("element", new File([element], "element.png", { type: "image/png" }));
  form.set("viewport", new File([viewport], "viewport.png", { type: "image/png" }));
  return form;
}

describe("요청 출처 검사", () => {
  it("health는 토큰 없이 열린다", async () => {
    const res = await app.request(`${BASE}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "switchboard" });
  });

  it("Host가 우리 주소가 아니면 거부한다 (DNS 리바인딩)", async () => {
    const res = await app.request(`${BASE}/v1/health`, { headers: { host: "evil.example:7490" } });
    expect(res.status).toBe(403);
  });

  it("웹 페이지와 sandbox iframe 오리진은 거부하고 확장 오리진은 통과시킨다", async () => {
    for (const origin of ["http://localhost:5199", "https://evil.example", "null"]) {
      const res = await app.request(`${BASE}/v1/health`, { headers: { origin } });
      expect(res.status, origin).toBe(403);
    }
    for (const origin of ["chrome-extension://abcdef", "extension://abcdef", "moz-extension://1234-5678"]) {
      const res = await app.request(`${BASE}/v1/health`, { headers: { origin } });
      expect(res.status, origin).toBe(200);
    }
  });

  it("토큰이 없거나 틀리면 401", async () => {
    expect((await app.request(`${BASE}/v1/sessions`)).status).toBe(401);
    expect((await app.request(`${BASE}/v1/sessions`, authed("sb_wrong"))).status).toBe(401);
  });
});

describe("페어링", () => {
  it("맞는 코드로 토큰을 받고, 코드는 한 번만 쓸 수 있다", async () => {
    const { code } = await auth.createPairCode();
    const post = (c: string) =>
      app.request(`${BASE}/v1/pair`, { method: "POST", body: JSON.stringify({ code: c }), headers: { "content-type": "application/json" } });
    const res = await post(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^sb_/);
    expect((await app.request(`${BASE}/v1/me`, authed(token))).status).toBe(200);
    expect((await post(code)).status).toBe(401);
  });

  it("5번 틀리면 잠긴다", async () => {
    const { code } = await auth.createPairCode();
    const wrong = code === "000000" ? "111111" : "000000";
    const post = (c: string) =>
      app.request(`${BASE}/v1/pair`, { method: "POST", body: JSON.stringify({ code: c }), headers: { "content-type": "application/json" } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(wrong)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    expect((await post(code)).status).toBe(429);
  });

  it("만료된 코드는 거부한다", async () => {
    let t = 1_000;
    const clocked = new Auth({ pairFile: paths.pairFile, tokensFile: paths.tokensFile, now: () => t });
    const { code } = await clocked.createPairCode(100);
    t += 101;
    expect(await clocked.redeem(code)).toEqual({ ok: false, error: "expired" });
  });

  it("토큰 파일은 사용자만 읽을 수 있고 해시만 저장한다", async () => {
    const token = await pairToken();
    const raw = readFileSync(paths.tokensFile, "utf8");
    expect(raw).not.toContain(token);
    const { statSync } = await import("node:fs");
    expect(statSync(paths.tokensFile).mode & 0o777).toBe(0o600);
  });
});

describe("세션", () => {
  it("세션 목록과 SSE 첫 이벤트", async () => {
    const token = await pairToken();
    registry.next = { sessions: [], takenAt: 5, tmuxRunning: false, warnings: ["x"] };
    const res = await app.request(`${BASE}/v1/sessions`, authed(token));
    expect(await res.json()).toMatchObject({ takenAt: 5, warnings: ["x"] });

    const ac = new AbortController();
    const sse = await app.request(`${BASE}/v1/events`, authed(token, { signal: ac.signal }));
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: sessions.updated");
    expect(chunk).toContain('"takenAt":5');
    await reader.cancel();
    ac.abort();
  });
});

describe("캡처와 요청", () => {
  it("캡처를 저장하고, 미리보기와 요청이 같은 프롬프트 형식을 쓴다", async () => {
    const token = await pairToken();
    const up = await app.request(`${BASE}/v1/captures`, authed(token, { method: "POST", body: captureForm(sampleCapture()) }));
    expect(up.status).toBe(201);
    const { id, dir: capDir } = (await up.json()) as { id: string; dir: string };
    for (const f of ["element.png", "viewport.png", "capture.json"]) expect(existsSync(join(capDir, f)), f).toBe(true);

    const json = (body: unknown) => authed(token, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const preview = (await (await app.request(`${BASE}/v1/preview`, json({ captureId: id, text: "드롭다운이 잘림\x1b[201~" }))).json()) as { prompt: string };
    expect(preview.prompt.split("\n")[0]).toBe("[switchboard #1] 드롭다운이 잘림[201~");
    expect(preview.prompt).toContain("- 대상: src/AvatarMenu.tsx:12  (<AvatarMenu> ← <Header>)");

    const req = await app.request(`${BASE}/v1/requests`, json({ captureId: id, text: "드롭다운이 잘림" }));
    expect(req.status).toBe(201);
    const info = (await req.json()) as { id: number; prompt: string; contextFile: string; sessionKey: string | null; dispatch: unknown };
    expect(info).toMatchObject({ id: 1, sessionKey: null, dispatch: null });
    expect(info.prompt).toContain("[switchboard #1] 드롭다운이 잘림");
    expect(info.prompt).toContain(join(capDir, "element.png"));
    expect(readFileSync(info.contextFile, "utf8")).toContain("DOM 발췌");

    const again = (await (await app.request(`${BASE}/v1/preview`, json({ captureId: id, text: "a" }))).json()) as { prompt: string };
    expect(again.prompt).toContain("[switchboard #2]");
    expect((await app.request(`${BASE}/v1/requests/1`, authed(token))).status).toBe(200);
  });

  it("프롬프트 언어: 확장이 보낸 lang을 따르고 요청에 남긴다(없으면 설정 언어)", async () => {
    const token = await pairToken();
    const up = await app.request(`${BASE}/v1/captures`, authed(token, { method: "POST", body: captureForm(sampleCapture()) }));
    const { id } = (await up.json()) as { id: string };
    const json = (body: unknown) => authed(token, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const en = (await (await app.request(`${BASE}/v1/requests`, json({ captureId: id, text: "fix it", lang: "en" }))).json()) as { id: number; prompt: string; contextFile: string };
    expect(en.prompt).toContain("- Target: src/AvatarMenu.tsx:12");
    expect(readFileSync(en.contextFile, "utf8")).toContain("## Request");
    expect(store.getRequest(en.id)?.lang).toBe("en");
    const ko = (await (await app.request(`${BASE}/v1/requests`, json({ captureId: id, text: "고쳐줘" }))).json()) as { prompt: string };
    expect(ko.prompt).toContain("- 대상: src/AvatarMenu.tsx:12");
    expect((await app.request(`${BASE}/v1/requests`, json({ captureId: id, text: "x", lang: "fr" }))).status).toBe(400);
  });

  it("저장된 스크린샷을 토큰이 있을 때만 내준다", async () => {
    const token = await pairToken();
    const up = await app.request(`${BASE}/v1/captures`, authed(token, { method: "POST", body: captureForm(sampleCapture()) }));
    const { id } = (await up.json()) as { id: string };
    const img = await app.request(`${BASE}/v1/captures/${id}/element.png`, authed(token));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await app.request(`${BASE}/v1/captures/${id}/element.png`)).status).toBe(401);
    expect((await app.request(`${BASE}/v1/captures/${id}/capture.json`, authed(token))).status).toBe(404);
    expect((await app.request(`${BASE}/v1/captures/nope/element.png`, authed(token))).status).toBe(404);
  });

  it("PNG가 아니거나 캡처 형식이 틀리면 거부한다", async () => {
    const token = await pairToken();
    const notPng = await app.request(`${BASE}/v1/captures`, authed(token, { method: "POST", body: captureForm(sampleCapture(), new Uint8Array([1, 2, 3])) }));
    expect(notPng.status).toBe(400);
    expect(await notPng.json()).toEqual({ error: "element-not-png" });

    const bad = captureForm(sampleCapture());
    bad.set("capture", JSON.stringify({ url: "x" }));
    const badRes = await app.request(`${BASE}/v1/captures`, authed(token, { method: "POST", body: bad }));
    expect(badRes.status).toBe(400);
    expect(((await badRes.json()) as { error: string }).error).toBe("bad-capture");
  });

  it("없는 캡처로 요청하면 404", async () => {
    const token = await pairToken();
    const res = await app.request(
      `${BASE}/v1/requests`,
      authed(token, { method: "POST", body: JSON.stringify({ captureId: "nope", text: "a" }), headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(404);
  });
});
