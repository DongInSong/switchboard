import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "./retention.ts";
import { Store } from "./store.ts";
import { sampleCapture } from "./testing/fixtures.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let root: string;
let caps: string;
let store: Store;

function capture(id: string, ageMs: number): string {
  const dir = join(caps, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "element.png"), Buffer.alloc(1000));
  writeFileSync(join(dir, "viewport.png"), Buffer.alloc(3000));
  store.insertCapture({ id, createdAt: NOW - ageMs, url: "http://localhost:5199/", origin: "http://localhost:5199", title: "t", dir, capture: sampleCapture() });
  return dir;
}

function request(captureId: string, ageMs: number): number {
  const id = store.reserveRequest(captureId, "text", "s1", NOW - ageMs);
  store.fillRequest(id, "prompt", join(caps, captureId, `context-${id}.md`));
  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-ret-"));
  caps = join(root, "captures");
  mkdirSync(caps);
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("cleanup", () => {
  it("보낸 요청은 14일, 안 보낸 캡처는 24시간 뒤 지우고, 폴더와 DB를 함께 지운다", async () => {
    const oldSent = capture("20261001-100000-aaaaaa", 20 * DAY);
    request("20261001-100000-aaaaaa", 20 * DAY);
    const recentSent = capture("20261025-100000-bbbbbb", 20 * DAY);
    request("20261025-100000-bbbbbb", 3 * DAY); // 오래된 캡처라도 최근에 다시 보냈으면 남긴다
    const oldUnsent = capture("20261031-100000-cccccc", 2 * DAY);
    const freshUnsent = capture("20261102-100000-dddddd", 2 * 3_600_000);

    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(r.removed.map((x) => [x.id, x.sent])).toEqual([
      ["20261001-100000-aaaaaa", true],
      ["20261031-100000-cccccc", false],
    ]);
    expect(r.freedBytes).toBe(8000);
    expect(existsSync(oldSent)).toBe(false);
    expect(existsSync(oldUnsent)).toBe(false);
    expect(existsSync(recentSent)).toBe(true);
    expect(existsSync(freshUnsent)).toBe(true);
    expect([...store.captureIds()].sort()).toEqual(["20261025-100000-bbbbbb", "20261102-100000-dddddd"]);
    expect(store.listRequests().map((x) => x.captureId)).toEqual(["20261025-100000-bbbbbb"]);
    expect(r.kept).toEqual({ count: 2, bytes: 8000 });
  });

  it("진행 중인 전달이 있으면 오래돼도 지우지 않는다", async () => {
    capture("20261001-100000-aaaaaa", 30 * DAY);
    const rid = request("20261001-100000-aaaaaa", 30 * DAY);
    store.insertDispatch({ requestId: rid, sessionKey: "s1", sessionName: "n", paneId: "%1", mode: "wait-idle", marker: "m", createdAt: NOW - 30 * DAY });
    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(r.removed).toEqual([]);
  });

  it("dry-run은 아무것도 지우지 않는다", async () => {
    const dir = capture("20261001-100000-aaaaaa", 30 * DAY);
    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW, { dryRun: true });
    expect(r.removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    expect(store.captureIds().size).toBe(1);
  });

  it("0이면 무기한 보관", async () => {
    capture("20261001-100000-aaaaaa", 300 * DAY);
    request("20261001-100000-aaaaaa", 300 * DAY);
    capture("20261002-100000-bbbbbb", 300 * DAY);
    const r = await cleanup(store, caps, { days: 0, unsentHours: 0 }, NOW);
    expect(r.removed).toEqual([]);
  });

  it("DB에 없는 오래된 캡처 폴더는 지우되, 이름이 캡처 형식이 아니면 건드리지 않는다", async () => {
    const orphan = join(caps, "20260901-100000-eeeeee");
    const other = join(caps, "notes");
    for (const d of [orphan, other]) {
      mkdirSync(d);
      writeFileSync(join(d, "x"), "1");
      utimesSync(d, new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    }
    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(r.orphans.map((o) => o.name)).toEqual(["20260901-100000-eeeeee"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("캡처 폴더 밖 경로는 DB에 있어도 지우지 않는다", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "1");
    store.insertCapture({ id: "20261001-100000-ffffff", createdAt: NOW - 30 * DAY, url: "u", origin: "", title: "t", dir: outside, capture: sampleCapture() });
    await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(store.captureIds().size).toBe(0);
  });
});

describe("연계 대상 보관", () => {
  it("연계 대상으로만 쓰인 캡처도 '보낸 요청'으로 세어 24시간 규칙에 걸리지 않는다", async () => {
    capture("20261102-090000-aaaaaa", 2 * DAY);
    capture("20261102-090100-bbbbbb", 2 * DAY);
    const id = store.reserveRequest("20261102-090000-aaaaaa", "t", "s1", NOW - 2 * DAY, ["20261102-090100-bbbbbb"]);
    store.fillRequest(id, "p", "c");
    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(r.removed).toEqual([]);
    expect(store.getRequest(id)?.captureIds).toEqual(["20261102-090000-aaaaaa", "20261102-090100-bbbbbb"]);
  });

  it("기한이 지나면 대표와 연계 대상을 함께 지운다", async () => {
    capture("20261001-090000-aaaaaa", 30 * DAY);
    capture("20261001-090100-bbbbbb", 30 * DAY);
    const id = store.reserveRequest("20261001-090000-aaaaaa", "t", "s1", NOW - 30 * DAY, ["20261001-090100-bbbbbb"]);
    store.fillRequest(id, "p", "c");
    const r = await cleanup(store, caps, { days: 14, unsentHours: 24 }, NOW);
    expect(r.removed.map((x) => x.id).sort()).toEqual(["20261001-090000-aaaaaa", "20261001-090100-bbbbbb"]);
    expect(store.captureIds().size).toBe(0);
    expect(store.listRequests()).toEqual([]);
  });
});
