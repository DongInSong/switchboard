import type { GitInfo } from "@switchboard/protocol";
import { run } from "../exec.ts";

export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  const res = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], {
    timeoutMs: 3_000,
  });
  if (res.code !== 0) return null;
  const [root, branch] = res.stdout.trim().split("\n");
  if (!root) return null;
  // 커밋이 없는 저장소는 "HEAD"가 그대로 나온다.
  return branch && branch !== "HEAD" ? { root, branch } : { root };
}

/** cwd별로 짧게 캐시한다. 세션 목록을 자주 갱신해도 git 호출이 쌓이지 않게. */
export function cachedGitInfo(ttlMs = 30_000, read = readGitInfo): (cwd: string) => Promise<GitInfo | null> {
  const cache = new Map<string, { at: number; value: Promise<GitInfo | null> }>();
  return (cwd) => {
    const hit = cache.get(cwd);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = read(cwd);
    cache.set(cwd, { at: now, value });
    return value;
  };
}
