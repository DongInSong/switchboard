import { readFile } from "node:fs/promises";

export type ProcStat = {
  pid: number;
  comm: string;
  ppid: number;
  /** 22번째 필드(starttime). 부팅 후 클록 틱 단위 문자열. */
  startTime: string;
};

/**
 * /proc/<pid>/stat 한 줄을 파싱한다.
 * comm(2번째 필드)에 공백이나 괄호가 들어갈 수 있으므로 마지막 ')' 기준으로 자른다.
 */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  // ')' 다음 공백 뒤부터 3번째 필드(state)가 시작한다. rest[i] = 필드 i+3.
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const startTime = rest[19];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || startTime === undefined) return null;
  return { pid, comm, ppid, startTime };
}

export async function readStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** pid 자신부터 init 직전까지의 계보. 첫 원소가 pid 자신이다. */
export async function ancestry(
  pid: number,
  read: (pid: number) => Promise<ProcStat | null> = readStat,
  maxDepth = 64,
): Promise<ProcStat[]> {
  const chain: ProcStat[] = [];
  let current = pid;
  while (current > 1 && chain.length < maxDepth) {
    const stat = await read(current);
    if (!stat) break;
    chain.push(stat);
    current = stat.ppid;
  }
  return chain;
}
