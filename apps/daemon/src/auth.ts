import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 확장 ↔ 데몬 인증.
 * - `switchboard pair`가 6자리 코드를 파일에 남긴다(2분, 5회 시도).
 * - 확장이 코드를 보내면 토큰을 발급하고, 토큰은 해시만 저장한다.
 * 같은 사용자만 읽을 수 있는 파일(0600)이 신뢰 경계다.
 */

type PairFile = { codeHash: string; expiresAt: number; attempts: number };
type TokenEntry = { hash: string; label: string; createdAt: number };
type TokensFile = { tokens: TokenEntry[] };

export const PAIR_TTL_MS = 120_000;
export const PAIR_MAX_ATTEMPTS = 5;

export type RedeemResult =
  | { ok: true; token: string }
  | { ok: false; error: "no-code" | "expired" | "invalid" | "locked" };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

async function writePrivate(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export class Auth {
  readonly #pairFile: string;
  readonly #tokensFile: string;
  readonly #now: () => number;
  #cache: { mtimeMs: number; hashes: string[] } | null = null;

  constructor(opts: { pairFile: string; tokensFile: string; now?: () => number }) {
    this.#pairFile = opts.pairFile;
    this.#tokensFile = opts.tokensFile;
    this.#now = opts.now ?? Date.now;
  }

  async createPairCode(ttlMs = PAIR_TTL_MS): Promise<{ code: string; expiresAt: number }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.#now() + ttlMs;
    await writePrivate(this.#pairFile, { codeHash: sha256(code), expiresAt, attempts: 0 } satisfies PairFile);
    return { code, expiresAt };
  }

  async redeem(code: string, label = "extension"): Promise<RedeemResult> {
    const pair = await readJson<PairFile>(this.#pairFile);
    if (!pair) return { ok: false, error: "no-code" };
    if (this.#now() > pair.expiresAt) {
      await rm(this.#pairFile, { force: true });
      return { ok: false, error: "expired" };
    }
    if (pair.attempts >= PAIR_MAX_ATTEMPTS) return { ok: false, error: "locked" };
    const normalized = code.replace(/\D/g, "");
    if (!sameHash(sha256(normalized), pair.codeHash)) {
      pair.attempts += 1;
      await writePrivate(this.#pairFile, pair);
      return { ok: false, error: pair.attempts >= PAIR_MAX_ATTEMPTS ? "locked" : "invalid" };
    }
    await rm(this.#pairFile, { force: true });
    const token = `sb_${randomBytes(32).toString("base64url")}`;
    const file = (await readJson<TokensFile>(this.#tokensFile)) ?? { tokens: [] };
    file.tokens.push({ hash: sha256(token), label: label.slice(0, 64), createdAt: this.#now() });
    await writePrivate(this.#tokensFile, file);
    this.#cache = null;
    return { ok: true, token };
  }

  async verify(token: string | undefined): Promise<boolean> {
    if (!token || !token.startsWith("sb_")) return false;
    const hashes = await this.#hashes();
    const h = sha256(token);
    return hashes.some((x) => sameHash(x, h));
  }

  /**
   * CLI용 토큰. 같은 사용자만 읽을 수 있는 파일에 두고(ssh 키처럼), 해시를 토큰 목록에 올린다.
   * 이미 있고 유효하면 그대로 쓴다.
   */
  async ensureCliToken(file: string): Promise<string> {
    try {
      const existing = (await readFile(file, "utf8")).trim();
      if (await this.verify(existing)) return existing;
    } catch {
      /* 새로 만든다 */
    }
    const token = `sb_${randomBytes(32).toString("base64url")}`;
    const tokens = (await readJson<TokensFile>(this.#tokensFile)) ?? { tokens: [] };
    tokens.tokens = tokens.tokens.filter((t) => t.label !== "cli");
    tokens.tokens.push({ hash: sha256(token), label: "cli", createdAt: this.#now() });
    await writePrivate(this.#tokensFile, tokens);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, token, { mode: 0o600 });
    await chmod(file, 0o600);
    this.#cache = null;
    return token;
  }

  /** 확장 연결 수(CLI 토큰 제외). */
  async extensionCount(): Promise<number> {
    const file = await readJson<TokensFile>(this.#tokensFile);
    return file?.tokens.filter((t) => t.label !== "cli").length ?? 0;
  }

  /** 확장 연결을 모두 끊는다. CLI 토큰은 남긴다. */
  async revokeAll(): Promise<number> {
    const file = (await readJson<TokensFile>(this.#tokensFile)) ?? { tokens: [] };
    const keep = file.tokens.filter((t) => t.label === "cli");
    await writePrivate(this.#tokensFile, { tokens: keep } satisfies TokensFile);
    this.#cache = null;
    return file.tokens.length - keep.length;
  }

  async tokenCount(): Promise<number> {
    return (await this.#hashes()).length;
  }

  /** 다른 프로세스(`switchboard pair --reset`)가 파일을 바꿔도 반영되도록 mtime으로 캐시한다. */
  async #hashes(): Promise<string[]> {
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(this.#tokensFile)).mtimeMs;
    } catch {
      return [];
    }
    if (this.#cache && this.#cache.mtimeMs === mtimeMs) return this.#cache.hashes;
    const file = await readJson<TokensFile>(this.#tokensFile);
    const hashes = file?.tokens.map((t) => t.hash) ?? [];
    this.#cache = { mtimeMs, hashes };
    return hashes;
  }
}
