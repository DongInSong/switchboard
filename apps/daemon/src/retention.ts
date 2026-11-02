import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Store } from "./store.ts";

/**
 * 캡처 보관 정책. 캡처 폴더(스크린샷 2장 + capture.json + context-N.md)와 DB 기록을 함께 지운다.
 * - 보낸 요청이 있는 캡처: 마지막 활동 뒤 days일
 * - 팝업만 열고 보내지 않은 캡처: unsentHours시간
 * - 진행 중인 전달이 있으면 지우지 않는다
 * - 캡처 폴더 밖은 절대 지우지 않는다
 */

export type RetentionPolicy = { days: number; unsentHours: number };

export const DEFAULT_RETENTION: RetentionPolicy = { days: 14, unsentHours: 24 };

/** SWITCHBOARD_RETENTION_DAYS, SWITCHBOARD_UNSENT_HOURS. 0이면 그 종류는 지우지 않는다. */
const CAPTURE_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

async function sizeOf(path: string): Promise<number> {
  let total = 0;
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return st.size;
    for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  } catch {
    /* 이미 없음 */
  }
  return total;
}

function inside(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p.startsWith(r + sep) && p !== r;
}

export type CleanupResult = {
  removed: { id: string; bytes: number; sent: boolean }[];
  orphans: { name: string; bytes: number }[];
  freedBytes: number;
  kept: { count: number; bytes: number };
};

export async function cleanup(store: Store, capturesDir: string, policy: RetentionPolicy, now: number, opts: { dryRun?: boolean } = {}): Promise<CleanupResult> {
  const sentCutoff = policy.days > 0 ? now - policy.days * DAY : -Infinity;
  const unsentCutoff = policy.unsentHours > 0 ? now - policy.unsentHours * HOUR : -Infinity;
  const removed: CleanupResult["removed"] = [];
  for (const c of store.expiredCaptures(sentCutoff, unsentCutoff)) {
    // 보낸 요청이 있는 캡처인데 보관 기간 정책이 0(무기한)이면 건너뛴다
    if (c.requests > 0 && policy.days === 0) continue;
    const bytes = await sizeOf(c.dir);
    if (!opts.dryRun) {
      if (inside(c.dir, capturesDir)) await rm(c.dir, { recursive: true, force: true });
      store.deleteCapture(c.id);
    }
    removed.push({ id: c.id, bytes, sent: c.requests > 0 });
  }

  // DB에 없는 폴더(이전 버전·중단된 업로드). 이름이 캡처 형식이고 보관 기간이 지난 것만.
  const orphans: CleanupResult["orphans"] = [];
  const known = store.captureIds();
  let names: string[] = [];
  try {
    names = await readdir(capturesDir);
  } catch {
    /* 폴더 없음 */
  }
  const orphanCutoff = Math.max(sentCutoff, unsentCutoff);
  let keptCount = 0;
  let keptBytes = 0;
  for (const name of names) {
    const path = join(capturesDir, name);
    if (removed.some((r) => r.id === name)) continue;
    if (known.has(name) || !CAPTURE_ID.test(name)) {
      if (known.has(name)) {
        keptCount++;
        keptBytes += await sizeOf(path);
      }
      continue;
    }
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory() || st.mtimeMs >= orphanCutoff) continue;
    const bytes = await sizeOf(path);
    if (!opts.dryRun) await rm(path, { recursive: true, force: true });
    orphans.push({ name, bytes });
  }
  const freedBytes = [...removed, ...orphans].reduce((n, x) => n + x.bytes, 0);
  return { removed, orphans, freedBytes, kept: { count: keptCount, bytes: keptBytes } };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
