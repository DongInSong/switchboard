import { dirname, sep } from "node:path";
import type { ReasonTag, Recommendation, Session } from "@switchboard/protocol";

/**
 * 휴리스틱 추천. 결정적 신호(소스 위치, dev 서버) 먼저, 활동·주제는 보조.
 * docs/ARCHITECTURE.md §5.6 의 신호표를 따른다.
 */

export type RecommendInput = {
  sessions: readonly Session[];
  sourceFile: string | null;
  devServerRoot: string | null;
  queryText: string;
  previousSessionKey: string | null;
  now: number;
  /** 설정으로 바꿀 수 있다(settings.ts recommend.*). */
  weights?: Weights;
  recentHalfLifeMs?: number;
};

export type Weights = { source: number; devServer: number; recent: number; topic: number; previous: number };
export const WEIGHTS: Weights = { source: 0.45, devServer: 0.3, recent: 0.15, topic: 0.1, previous: 0.05 };
const RECENT_HALF_LIFE_MS = 45 * 60_000;

function isUnder(path: string, root: string | undefined): boolean {
  if (!root) return false;
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + sep);
}

const depth = (p: string) => p.split(sep).filter(Boolean).length;

/** 세션의 루트 후보 중 path를 포함하는 가장 깊은 것. */
function matchedRoot(s: Session, path: string): string | undefined {
  return [s.git?.root, s.cwd].filter((r): r is string => isUnder(path, r)).sort((a, b) => depth(b) - depth(a))[0];
}

/**
 * 여러 세션이 같은 파일을 포함할 때(예: 작업 공간 루트에서 띄운 세션) 가장 가까운 루트만 1, 나머지는 0.6.
 */
function normalizeByDepth(matches: Map<string, number>): Map<string, number> {
  const max = Math.max(0, ...matches.values());
  return new Map([...matches].map(([k, d]) => [k, d === max ? 1 : 0.6]));
}

const STOP = new Set(["the", "and", "for", "src", "tsx", "jsx", "ts", "js", "vue", "svelte", "index", "div", "span", "http", "https", "localhost", "com", "www"]);

export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t)))];
}

/** 질의 토큰 중 세션 문서에 있는 비율. 한글 조사 때문에 앞부분 일치도 인정한다(2자 이상). */
export function topicScore(query: readonly string[], doc: readonly string[]): number {
  if (query.length === 0 || doc.length === 0) return 0;
  const docSet = new Set(doc);
  let hit = 0;
  for (const q of query) {
    if (docSet.has(q) || doc.some((d) => (d.length >= 2 && q.startsWith(d)) || (q.length >= 2 && d.startsWith(q)))) hit++;
  }
  return hit / query.length;
}

function recentScore(s: Session, file: string | null, now: number, halfLifeMs: number): number {
  if (!file) return 0;
  let best = 0;
  const dir = dirname(file);
  for (const f of s.recentFiles) {
    const opWeight = f.op === "read" ? 0.5 : 1;
    const place = f.path === file ? 1 : dirname(f.path) === dir ? 0.5 : 0;
    if (!place) continue;
    const decay = f.at ? Math.pow(0.5, Math.max(0, now - f.at) / halfLifeMs) : 0.5;
    best = Math.max(best, opWeight * place * decay);
  }
  return best;
}

function sessionDoc(s: Session): string[] {
  return tokenize([s.title ?? "", ...s.recentPrompts, s.lastAssistantSummary ?? "", ...s.recentFiles.map((f) => f.path.split(sep).pop() ?? "")].join(" "));
}

export function recommend(input: RecommendInput, limit = 3): Recommendation[] {
  const candidates = input.sessions.filter((s) => s.dispatchable);
  if (candidates.length === 0) return [];

  const sourceDepth = new Map<string, number>();
  const serverDepth = new Map<string, number>();
  for (const s of candidates) {
    if (input.sourceFile) {
      const r = matchedRoot(s, input.sourceFile);
      if (r) sourceDepth.set(s.key, depth(r));
    }
    if (input.devServerRoot) {
      const r = matchedRoot(s, input.devServerRoot);
      if (r) serverDepth.set(s.key, depth(r));
      // 세션이 dev 서버 폴더 안쪽(하위 패키지)에서 떠 있는 경우도 인정
      else if (isUnder(s.cwd, input.devServerRoot)) serverDepth.set(s.key, depth(input.devServerRoot) - 0.5);
    }
  }
  const S1 = normalizeByDepth(sourceDepth);
  const S2 = normalizeByDepth(serverDepth);
  const query = tokenize(input.queryText);
  const W = input.weights ?? WEIGHTS;
  const halfLife = input.recentHalfLifeMs ?? RECENT_HALF_LIFE_MS;

  const scored = candidates.map((s) => {
    const s1 = S1.get(s.key) ?? 0;
    const s2 = S2.get(s.key) ?? 0;
    const s3 = recentScore(s, input.sourceFile, input.now, halfLife);
    const s4 = topicScore(query, sessionDoc(s));
    const prev = input.previousSessionKey === s.key;
    const availability = s.status === "idle" ? 0.05 : s.status === "busy" ? -0.03 : s.status === "waiting" ? -0.08 : -0.05;
    const score =
      W.source * s1 + W.devServer * s2 + W.recent * s3 + W.topic * s4 + (prev ? W.previous : 0) + availability;
    const reasons: ReasonTag[] = [];
    if (s1 > 0) reasons.push("source-match");
    if (s2 >= 0.6) reasons.push("dev-server");
    if (s3 >= 0.25) reasons.push("recent-edit");
    if (s4 >= 0.25) reasons.push("topic");
    if (prev) reasons.push("previous-choice");
    return { s, score, s1, s2, reasons };
  });
  // 동점이면 시작 순서(데몬이 준 순서) 유지
  scored.sort((a, b) => b.score - a.score);

  const top = scored.filter((x) => x.score >= 0.1).slice(0, limit);
  return top.map((x, i) => {
    const next = scored[i + 1]?.score ?? 0;
    const margin = x.score - next;
    const hard = x.s1 >= 1 || x.s2 >= 1;
    const confidence: Recommendation["confidence"] =
      i === 0 && hard && margin >= 0.15 ? "high" : i === 0 && x.score >= 0.3 && margin >= 0.05 ? "medium" : "low";
    return { sessionKey: x.s.key, rank: i + 1, score: Math.round(x.score * 1000) / 1000, confidence, reasons: x.reasons, method: "heuristic" as const };
  });
}
