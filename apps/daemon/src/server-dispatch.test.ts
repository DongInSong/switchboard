import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatch, DispatchMode, Session, SessionSnapshot } from "@switchboard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth } from "./auth.ts";
import { pathsFrom } from "./config.ts";
import { ContextService } from "./context.ts";
import { createApp, type DispatcherLike } from "./server.ts";
import { Store } from "./store.ts";
import { sampleCapture } from "./testing/fixtures.ts";

const BASE = "http://127.0.0.1:7490";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

let dir: string;
let project: string;
let store: Store;
let token: string;
let enqueued: { requestId: number; key: string; mode: DispatchMode; marker: string }[];
let app: ReturnType<typeof createApp>;

function session(over: Partial<Session> = {}): Session {
  return {
    key: "s1",
    sessionId: "sid-1",
    name: "fixture-71",
    kind: "interactive",
    cwd: project,
    startedAt: 1,
    pid: 10,
    status: "idle",
    dispatchable: true,
    tmux: { session: "t", windowId: "@1", windowIndex: 0, paneId: "%4", paneCommand: "claude", inMode: false, via: "ancestry" },
    recentPrompts: [],
    recentFiles: [],
    ...over,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sb-srv-"));
  project = join(dir, "fixture");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "AvatarMenu.tsx"), "export {}\n");
  const paths = pathsFrom(join(dir, "state"), join(dir, "data"));
  store = new Store(":memory:");
  const auth = new Auth({ pairFile: paths.pairFile, tokensFile: paths.tokensFile });
  token = await auth.ensureCliToken(paths.cliTokenFile);
  const snap: SessionSnapshot = {
    takenAt: 1,
    tmuxRunning: true,
    warnings: [],
    sessions: [session(), session({ key: "s2", name: "elsewhere", cwd: join(dir, "other") }), session({ key: "bg", name: "bg", dispatchable: false })],
  };
  const registry = Object.assign(new EventEmitter(), { snapshot: snap, refresh: async () => snap });
  enqueued = [];
  let n = 0;
  const dispatcher: DispatcherLike = {
    enqueue: (requestId, s, mode, marker) => {
      enqueued.push({ requestId, key: s.key, mode, marker });
      return store.insertDispatch({ requestId, sessionKey: s.key, sessionName: s.name, paneId: "%4", mode, marker, createdAt: ++n });
    },
    cancel: (id) => store.updateDispatch(id, { state: "cancelled" }),
  };
  const context = new ContextService({ registry, activity: null, portOwner: async () => project });
  app = createApp({ auth, store, registry, paths, port: 7490, context, dispatcher, lang: "ko" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
const post = (body: unknown) => auth({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function upload(): Promise<{ id: string; recommendations: { sessionKey: string; reasons: string[]; confidence: string }[] }> {
  const form = new FormData();
  form.set("capture", JSON.stringify(sampleCapture()));
  form.set("element", new File([PNG], "e.png"));
  form.set("viewport", new File([PNG], "v.png"));
  const res = await app.request(`${BASE}/v1/captures`, auth({ method: "POST", body: form }));
  expect(res.status).toBe(201);
  return res.json() as never;
}

describe("추천과 전달 API", () => {
  it("캡처를 올리면 dev 서버·소스 파일이 속한 세션을 추천한다", async () => {
    const { recommendations } = await upload();
    expect(recommendations[0]).toMatchObject({ sessionKey: "s1", confidence: "high" });
    expect(recommendations[0]!.reasons).toEqual(expect.arrayContaining(["source-match", "dev-server"]));
    expect(recommendations.map((r) => r.sessionKey)).not.toContain("bg");
  });

  it("세션을 고르면 대기열에 넣고, 프롬프트의 소스 경로는 그 세션 기준 상대 경로", async () => {
    const { id } = await upload();
    const res = await app.request(`${BASE}/v1/requests`, post({ captureId: id, text: "드롭다운이 잘림", sessionKey: "s1" }));
    expect(res.status).toBe(201);
    const info = (await res.json()) as { id: number; prompt: string; dispatch: Dispatch };
    expect(enqueued).toEqual([{ requestId: info.id, key: "s1", mode: "wait-idle", marker: `[switchboard #${info.id}]` }]);
    expect(info.prompt).toContain("- 대상: src/AvatarMenu.tsx:12  (<AvatarMenu> ← <Header>)");
    expect(info.dispatch).toMatchObject({ state: "queued", sessionName: "fixture-71" });

    // 진행 중이면 다시 보내기 거부, 취소는 가능
    const again = await app.request(`${BASE}/v1/requests/${info.id}/dispatch`, post({}));
    expect(again.status).toBe(409);
    const cancel = await app.request(`${BASE}/v1/dispatches/${info.dispatch.id}/cancel`, auth({ method: "POST" }));
    expect(((await cancel.json()) as Dispatch).state).toBe("cancelled");

    // 끝난 뒤에는 다른 세션으로 다시 보낼 수 있고, 경로는 그 세션 기준(밖이면 절대 경로)으로 다시 쓴다
    const re = await app.request(`${BASE}/v1/requests/${info.id}/dispatch`, post({ sessionKey: "s2" }));
    expect(re.status).toBe(202);
    const reInfo = (await re.json()) as { prompt: string; sessionKey: string };
    expect(reInfo.sessionKey).toBe("s2");
    expect(reInfo.prompt).toContain(`- 대상: ${join(project, "src", "AvatarMenu.tsx")}:12`);
    expect(enqueued.at(-1)).toMatchObject({ key: "s2" });
  });

  it("보낼 수 없는 세션과 없는 세션은 거절", async () => {
    const { id } = await upload();
    expect((await app.request(`${BASE}/v1/requests`, post({ captureId: id, text: "a", sessionKey: "bg" }))).status).toBe(409);
    expect((await app.request(`${BASE}/v1/requests`, post({ captureId: id, text: "a", sessionKey: "nope" }))).status).toBe(409);
    expect(enqueued).toEqual([]);
  });

  it("요청 목록에 전달 상태가 함께 온다", async () => {
    const { id } = await upload();
    await app.request(`${BASE}/v1/requests`, post({ captureId: id, text: "첫째", sessionKey: "s1" }));
    await app.request(`${BASE}/v1/requests`, post({ captureId: id, text: "둘째" }));
    const list = (await (await app.request(`${BASE}/v1/requests?limit=5`, auth())).json()) as { id: number; text: string; dispatch: Dispatch | null }[];
    expect(list.map((r) => [r.text, r.dispatch?.state ?? null])).toEqual([
      ["둘째", null],
      ["첫째", "queued"],
    ]);
  });
});

describe("연계 대상", () => {
  it("대상 여러 개를 한 요청으로: 프롬프트에 대상마다 위치·스크린샷, 기록에 대상 전부", async () => {
    const a = await upload();
    const b = await upload();
    const res = await app.request(`${BASE}/v1/requests`, post({ captureId: a.id, extraCaptureIds: [b.id, a.id], text: "두 곳 간격을 맞춰줘", sessionKey: "s1" }));
    expect(res.status).toBe(201);
    const info = (await res.json()) as { id: number; prompt: string; captureIds: string[] };
    expect(info.captureIds).toEqual([a.id, b.id]);
    const lines = info.prompt.split("\n");
    expect(lines[0]).toBe(`[switchboard #${info.id}] 두 곳 간격을 맞춰줘`);
    expect(lines.filter((l) => l.startsWith("- 대상 "))).toEqual([
      "- 대상 1: src/AvatarMenu.tsx:12  (<AvatarMenu> ← <Header>)",
      "- 대상 2: src/AvatarMenu.tsx:12  (<AvatarMenu> ← <Header>)",
    ]);
    expect(lines.filter((l) => l.startsWith("  스크린샷: "))).toHaveLength(2);
    expect(info.prompt.match(/- 페이지: /g)).toHaveLength(1);
  });

  it("없는 연계 캡처면 404", async () => {
    const a = await upload();
    const res = await app.request(`${BASE}/v1/requests`, post({ captureId: a.id, extraCaptureIds: ["nope"], text: "a" }));
    expect(res.status).toBe(404);
  });
});

describe("이어서 쓰기", () => {
  it("새 대상 없이: 같은 세션으로 '#N에 이어서' 한 줄만", async () => {
    const a = await upload();
    const first = (await (await app.request(`${BASE}/v1/requests`, post({ captureId: a.id, text: "드롭다운이 잘림", sessionKey: "s1" }))).json()) as { id: number };
    const res = await app.request(`${BASE}/v1/requests/${first.id}/followup`, post({ text: "높이도 같이 줄여줘" }));
    expect(res.status).toBe(201);
    const info = (await res.json()) as { id: number; parentId: number; prompt: string; sessionKey: string };
    expect(info).toMatchObject({ parentId: first.id, sessionKey: "s1" });
    expect(info.prompt).toBe(`[switchboard #${info.id}] 높이도 같이 줄여줘\n\n- #${first.id}에 이어서`);
    expect(enqueued.at(-1)).toMatchObject({ requestId: info.id, key: "s1" });
  });

  it("새 대상을 덧붙이면 대상 줄과 스크린샷을 함께", async () => {
    const a = await upload();
    const b = await upload();
    const first = (await (await app.request(`${BASE}/v1/requests`, post({ captureId: a.id, text: "x", sessionKey: "s1" }))).json()) as { id: number };
    const info = (await (await app.request(`${BASE}/v1/requests/${first.id}/followup`, post({ text: "이것도", extraCaptureIds: [b.id] }))).json()) as { prompt: string; captureIds: string[] };
    expect(info.captureIds).toEqual([b.id]);
    expect(info.prompt).toContain(`- #${first.id}에 이어서\n- 대상 1: src/AvatarMenu.tsx:12`);
    expect(info.prompt).toContain("  스크린샷: ");
  });

  it("세션 없이 저장만 한 요청에는 이어 쓸 수 없다", async () => {
    const a = await upload();
    const saved = (await (await app.request(`${BASE}/v1/requests`, post({ captureId: a.id, text: "x" }))).json()) as { id: number };
    expect((await app.request(`${BASE}/v1/requests/${saved.id}/followup`, post({ text: "y" }))).status).toBe(400);
  });
});
