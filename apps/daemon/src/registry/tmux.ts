import { run } from "../exec.ts";

export type Pane = {
  session: string;
  windowId: string;
  windowIndex: number;
  paneId: string;
  panePid: number;
  command: string;
  inMode: boolean;
  path: string;
};

export type PanesResult = {
  panes: Pane[];
  serverRunning: boolean;
  error?: string;
};

const FIELDS = [
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{pane_in_mode}",
  "#{pane_current_path}",
] as const;

/**
 * 필드 구분자. tmux는 출력할 때 제어 문자를 8진수 문자열로 바꾸는데(`\x1f` → `\037`), 탭은 그대로 둔다.
 * 경로는 마지막 필드라 탭이 들어 있어도 나머지를 합쳐 복원한다.
 */
const SEP = "\t";
export const PANE_FORMAT = FIELDS.join(SEP);

export function parsePanes(stdout: string): Pane[] {
  const panes: Pane[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split(SEP);
    if (parts.length < FIELDS.length) continue;
    const [session, windowId, windowIndex, paneId, panePid, command, inMode, ...pathParts] = parts as [
      string, string, string, string, string, string, string, ...string[],
    ];
    const pid = Number(panePid);
    if (!Number.isInteger(pid)) continue;
    panes.push({
      session,
      windowId,
      windowIndex: Number(windowIndex),
      paneId,
      panePid: pid,
      command,
      inMode: inMode === "1",
      path: pathParts.join(SEP),
    });
  }
  return panes;
}

export async function listPanes(tmuxBin = "tmux", socket?: string): Promise<PanesResult> {
  const args = ["list-panes", "-a", "-F", PANE_FORMAT];
  const res = await run(tmuxBin, socket ? ["-L", socket, ...args] : args, { timeoutMs: 5_000 });
  if (res.code === 0) return { panes: parsePanes(res.stdout), serverRunning: true };
  // tmux 서버가 없으면 "no server running on ..." 으로 종료 코드 1.
  if (/no server running|error connecting/i.test(res.stderr)) {
    return { panes: [], serverRunning: false };
  }
  return { panes: [], serverRunning: false, error: res.error ?? res.stderr.trim() };
}
