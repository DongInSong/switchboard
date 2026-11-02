import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { run } from "../exec.ts";

/**
 * `claude agents --json` 한 항목. 공식 문서의 필드만 의존하고, 모르는 필드는 무시한다.
 * https://code.claude.com/docs/en/agent-view
 */
export const RawAgent = z.looseObject({
  id: z.string().optional(),
  pid: z.number().int().optional(),
  cwd: z.string(),
  kind: z.string(),
  startedAt: z.number(),
  sessionId: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  state: z.string().optional(),
});
export type RawAgent = z.infer<typeof RawAgent>;

export type AgentsResult = {
  agents: RawAgent[];
  /** 항목 단위 파싱 실패, 명령 실패 등. */
  warnings: string[];
  error?: string;
};

export function parseAgents(stdout: string): AgentsResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { agents: [], warnings: [], error: "claude agents --json: not JSON" };
  }
  if (!Array.isArray(data)) {
    return { agents: [], warnings: [], error: "claude agents --json: not an array" };
  }
  const agents: RawAgent[] = [];
  const warnings: string[] = [];
  data.forEach((item, i) => {
    const parsed = RawAgent.safeParse(item);
    if (parsed.success) agents.push(parsed.data);
    else warnings.push(`claude agents --json[${i}] skipped: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  });
  return { agents, warnings };
}

/** 테스트용: `claude agents --json` 대신 같은 형식의 JSON 파일을 읽는다(SWITCHBOARD_AGENTS_FILE). */
export async function listAgentsFromFile(file: string): Promise<AgentsResult> {
  try {
    return parseAgents(await readFile(file, "utf8"));
  } catch (e) {
    return { agents: [], warnings: [], error: `agents file read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function listAgents(claudeBin = "claude"): Promise<AgentsResult> {
  // cwd 필터 없이 모든 프로젝트의 세션을 받는다.
  const res = await run(claudeBin, ["agents", "--json"], { timeoutMs: 15_000, cwd: homedir() });
  if (res.code !== 0) {
    return { agents: [], warnings: [], error: `claude agents --json failed: ${res.error ?? res.stderr.trim()}` };
  }
  return parseAgents(res.stdout);
}
