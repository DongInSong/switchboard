import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code 내부 세션 레지스트리(`~/.claude/sessions/<pid>.json`).
 * 공식 인터페이스가 아니므로 변경 감지 힌트와 tmux 위치 폴백에만 쓴다.
 */
export type RegistryFileInfo = {
  procStart?: string;
  /** "cli", "claude-vscode" 등. 세션을 띄운 곳 표시에만 쓴다. */
  entrypoint?: string;
  tmux?: { session: string; windowId: string; paneId: string };
};

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function sessionsDir(): string {
  return join(claudeConfigDir(), "sessions");
}

/** "trio:@1.%4" → { session: "trio", windowId: "@1", paneId: "%4" } */
export function parseTmuxField(value: string): RegistryFileInfo["tmux"] | undefined {
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const session = value.slice(0, colon);
  const m = /^(@\d+)\.(%\d+)$/.exec(value.slice(colon + 1));
  if (!m) return undefined;
  return { session, windowId: m[1]!, paneId: m[2]! };
}

export function parseRegistryFile(text: string): RegistryFileInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const rec = data as Record<string, unknown>;
  const info: RegistryFileInfo = {};
  if (typeof rec.procStart === "string") info.procStart = rec.procStart;
  if (typeof rec.entrypoint === "string") info.entrypoint = rec.entrypoint;
  if (typeof rec.tmux === "string") {
    const tmux = parseTmuxField(rec.tmux);
    if (tmux) info.tmux = tmux;
  }
  return info;
}

export async function readRegistryFile(pid: number, dir = sessionsDir()): Promise<RegistryFileInfo | null> {
  try {
    return parseRegistryFile(await readFile(join(dir, `${pid}.json`), "utf8"));
  } catch {
    return null;
  }
}
