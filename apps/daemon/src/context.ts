import { access, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Capture, Recommendation, Session, SessionSnapshot, SourceHint } from "@switchboard/protocol";
import type { ActivityTracker } from "./activity/transcript.ts";
import { normalizeSourcePath } from "./compose.ts";
import { run } from "./exec.ts";
import { recommend, type Weights } from "./recommend.ts";
import type { RegistryLike } from "./server.ts";

/** 페이지·소스와 세션을 잇는 분석: dev 서버 포트 소유자, 소스 파일 절대 경로, 추천. */

export type Listener = { address: string; port: number; pid: number };

/** `ss -ltnpH` 출력 → 리스너. 같은 사용자 프로세스만 pid가 보인다. */
export function parseSsListeners(out: string): Listener[] {
  const result: Listener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || !cols[3]) continue;
    const m = /^(.*):(\d+)$/.exec(cols[3]);
    const pid = /pid=(\d+)/.exec(line)?.[1];
    if (!m || !pid) continue;
    result.push({ address: m[1]!, port: Number(m[2]), pid: Number(pid) });
  }
  return result;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function localPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.has(u.hostname)) return null;
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** 페이지 포트를 연 프로세스의 작업 디렉터리. */
export async function portOwnerCwd(port: number): Promise<string | null> {
  const res = await run("ss", ["-ltnpH", `sport = :${port}`], { timeoutMs: 2000 });
  if (res.code !== 0) return null;
  const owner = parseSsListeners(res.stdout).find((l) => l.port === port);
  if (!owner) return null;
  try {
    return await readlink(`/proc/${owner.pid}/cwd`);
  } catch {
    return null;
  }
}

export function isUnder(path: string, root: string): boolean {
  if (!root) return false;
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + sep);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 프레임워크가 준 경로를 실제 파일 절대 경로로. 알려진 루트(dev 서버 cwd, 세션 루트) 안의 파일만 인정한다
 * (페이지가 마커로 임의 경로를 주장해도 프롬프트에 엉뚱한 파일이 실리지 않게).
 */
export async function resolveSource(hint: SourceHint, roots: readonly string[]): Promise<string | null> {
  const p = normalizeSourcePath(hint.file);
  if (!p) return null;
  const candidates = isAbsolute(p) ? [p] : roots.map((r) => join(r, p));
  for (const c of candidates) {
    if (!(await exists(c))) continue;
    const real = await realpath(c).catch(() => c);
    if (roots.some((r) => isUnder(real, r))) return real;
  }
  return null;
}

export type CaptureAnalysis = { sourceFile: string | null; devServerRoot: string | null };

export type ContextDeps = {
  registry: RegistryLike;
  activity: ActivityTracker | null;
  portOwner?: (port: number) => Promise<string | null>;
  /** 추천 가중치·반감기(설정). 없으면 기본값. */
  recommend?: { weights: Weights; recentHalfLifeMs: number };
};

export class ContextService {
  readonly #d: ContextDeps;
  readonly #analysis = new Map<string, Promise<CaptureAnalysis>>();

  constructor(d: ContextDeps) {
    this.#d = d;
  }

  async sessions(fresh = false): Promise<SessionSnapshot> {
    const snap = fresh || !this.#d.registry.snapshot ? await this.#d.registry.refresh() : this.#d.registry.snapshot;
    return this.#d.activity ? this.#d.activity.enrich(snap) : snap;
  }

  /** 캡처마다 한 번만 분석한다. */
  analyze(captureId: string, capture: Capture, sessions: readonly Session[]): Promise<CaptureAnalysis> {
    let p = this.#analysis.get(captureId);
    if (!p) {
      p = this.#analyzeNow(capture, sessions);
      this.#analysis.set(captureId, p);
      if (this.#analysis.size > 200) this.#analysis.delete(this.#analysis.keys().next().value!);
    }
    return p;
  }

  async #analyzeNow(capture: Capture, sessions: readonly Session[]): Promise<CaptureAnalysis> {
    const port = localPort(capture.url);
    const devServerRoot = port ? await (this.#d.portOwner ?? portOwnerCwd)(port).catch(() => null) : null;
    const roots = [...new Set([devServerRoot, ...sessions.flatMap((s) => [s.git?.root, s.cwd])].filter((r): r is string => !!r))];
    let sourceFile: string | null = null;
    for (const hint of capture.source) {
      sourceFile = await resolveSource(hint, roots);
      if (sourceFile) break;
    }
    return { sourceFile, devServerRoot };
  }

  async recommend(captureId: string, capture: Capture, text: string, previousSessionKey: string | null): Promise<{ recommendations: Recommendation[]; analysis: CaptureAnalysis; snapshot: SessionSnapshot }> {
    const snapshot = await this.sessions();
    const analysis = await this.analyze(captureId, capture, snapshot.sessions);
    const hint = capture.source[0];
    const queryText = [
      text,
      ...(hint?.componentStack?.map((c) => c.name) ?? []),
      hint ? normalizeSourcePath(hint.file).split("/").pop() : "",
      capture.selection.primary.text,
      capture.title,
    ].join(" ");
    const recommendations = recommend({
      sessions: snapshot.sessions,
      sourceFile: analysis.sourceFile,
      devServerRoot: analysis.devServerRoot,
      queryText,
      previousSessionKey,
      now: Date.now(),
      ...this.#d.recommend,
    });
    return { recommendations, analysis, snapshot };
  }
}

/** 프롬프트에 쓸 소스 경로: 세션 cwd 안이면 상대 경로, 아니면 절대 경로. */
export function displayPath(file: string, sessionCwd: string | undefined): string {
  if (sessionCwd && isUnder(file, sessionCwd) && file !== sessionCwd) return relative(sessionCwd, file);
  return file;
}

