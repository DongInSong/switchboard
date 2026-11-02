import { readFile } from "node:fs/promises";
import { run } from "../exec.ts";

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

export async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * macOS 등 /proc가 없는 곳: `ps -A -o pid=,ppid=,lstart=,comm=` 한 줄.
 * lstart(시작 시각, 예 "Mon Nov  2 16:46:01 2026")를 pid 재사용 판별용 startTime으로 쓴다(LC_ALL=C로 고정).
 */
export function parsePsLine(line: string): ProcStat | null {
  const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), startTime: m[3]!.replace(/\s+/g, " "), comm: m[4]!.trim() };
}

/** ps 한 번으로 전체 프로세스 표를 만들고 잠깐(기본 2초) 재사용한다. 계보를 따라가며 pid마다 ps를 부르지 않게. */
export function psReader(
  list: () => Promise<string | null> = async () => {
    const res = await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { timeoutMs: 3000, env: { ...process.env, LC_ALL: "C" } });
    return res.code === 0 ? res.stdout : null;
  },
  ttlMs = 2000,
  now: () => number = Date.now,
): (pid: number) => Promise<ProcStat | null> {
  let table: Map<number, ProcStat> | null = null;
  let at = 0;
  let loading: Promise<Map<number, ProcStat>> | null = null;
  const load = async () => {
    const out = (await list()) ?? "";
    const map = new Map<number, ProcStat>();
    for (const line of out.split("\n")) {
      const p = parsePsLine(line);
      if (p) map.set(p.pid, p);
    }
    return map;
  };
  return async (pid) => {
    if (!table || now() - at > ttlMs) {
      loading ??= load().finally(() => {
        loading = null;
      });
      table = await loading;
      at = now();
    }
    return table.get(pid) ?? null;
  };
}

/** 테스트용: SWITCHBOARD_PROC_SOURCE=ps 이면 Linux에서도 macOS 경로(ps)를 쓴다. */
const USE_PROC = process.platform === "linux" && process.env.SWITCHBOARD_PROC_SOURCE !== "ps";

/** /proc의 시작 시각은 Linux에서만 Claude Code 레지스트리 파일과 같은 형식이다. 다른 곳에서는 비교하지 않는다. */
export const PROC_START_COMPARABLE = USE_PROC;

export const readStat: (pid: number) => Promise<ProcStat | null> = USE_PROC ? readProcStat : psReader();

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
