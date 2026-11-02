/**
 * 설정 탭의 주소 다루기(순수 함수).
 * - 데몬 주소: 이 컴퓨터(루프백)만. 토큰이 다른 곳으로 새지 않게.
 * - 자동 복원 주소: 새로고침 뒤 쓰던 팝업을 다시 띄울 사이트. 권한 패턴(`http://host/*`)으로 바꾼다.
 */

export const DEFAULT_BASE = "http://127.0.0.1:7490";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function normalizeDaemonBase(input: string): { ok: true; base: string } | { ok: false; error: "invalid" | "not-local" } {
  let v = input.trim();
  if (/^\d{1,5}$/.test(v)) v = `127.0.0.1:${v}`;
  if (!/^[a-z]+:\/\//i.test(v)) v = `http://${v}`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (u.protocol !== "http:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username) return { ok: false, error: "invalid" };
  if (!LOOPBACK.has(u.hostname)) return { ok: false, error: "not-local" };
  return { ok: true, base: u.origin };
}

/** 데몬 주소에 필요한 권한 패턴. */
export function daemonPattern(base: string): string {
  return `${new URL(base).origin}/*`;
}

/** 입력한 사이트 → 권한 패턴들. 스킴을 안 쓰면 http·https 둘 다. 포트는 패턴에서 빠진다(모든 포트). */
export function restorePatterns(input: string): string[] | null {
  const v = input.trim();
  if (!v || v.includes("*") || v.includes(" ")) return null;
  const hasScheme = /^[a-z]+:\/\//i.test(v);
  let u: URL;
  try {
    u = new URL(hasScheme ? v : `http://${v}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.hostname.includes("%")) return null;
  const host = u.hostname;
  return hasScheme ? [`${u.protocol}//${host}/*`] : [`http://${host}/*`, `https://${host}/*`];
}

/** 허용된 권한 중 사용자가 추가한 자동 복원 주소를 호스트별로 묶는다(설치 때 받은 데몬 권한, 데몬 주소는 뺌). */
export function restoreHosts(granted: readonly string[], exclude: readonly string[]): { host: string; patterns: string[] }[] {
  const skip = new Set(exclude);
  const byHost = new Map<string, string[]>();
  for (const p of granted) {
    if (skip.has(p) || p === "<all_urls>") continue;
    const m = /^(https?|\*):\/\/([^/]+)\/\*$/.exec(p);
    if (!m) continue;
    const host = m[2]!;
    byHost.set(host, [...(byHost.get(host) ?? []), p]);
  }
  return [...byHost.entries()].map(([host, patterns]) => ({ host, patterns })).sort((a, b) => a.host.localeCompare(b.host));
}
