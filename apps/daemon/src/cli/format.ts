import { homedir } from "node:os";
import type { Session, SessionSnapshot } from "@switchboard/protocol";

export type Style = {
  dim(s: string): string;
  bold(s: string): string;
  color(s: string, code: number): string;
  /** Claude 오렌지(#D97757). 트루컬러 터미널(Windows Terminal 등) 기준. */
  accent(s: string): string;
};

export const plain: Style = { dim: (s) => s, bold: (s) => s, color: (s) => s, accent: (s) => s };

export const ansi: Style = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  color: (s, code) => `\x1b[${code}m${s}\x1b[39m`,
  accent: (s) => `\x1b[38;2;217;119;87m${s}\x1b[39m`,
};

export function styleFor(stream: NodeJS.WriteStream): Style {
  return stream.isTTY && !process.env.NO_COLOR ? ansi : plain;
}

export function tildify(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 터미널 폭 계산용. 한글 등 동아시아 전각 문자는 2칸. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function statusText(s: Session): string {
  if (s.kind === "background") return s.backgroundState ?? "bg";
  if (!s.status) return "?";
  return s.status === "waiting" && s.waitingFor ? `waiting (${s.waitingFor})` : s.status;
}

function statusColor(s: Session): number {
  if (s.kind === "background") return 90;
  switch (s.status) {
    case "idle":
      return 32;
    case "busy":
      return -1; // Claude 오렌지(작업 중 = Claude Code 스피너 색)
    case "waiting":
      return 33;
    default:
      return 90;
  }
}

export function paneText(s: Session): string {
  return s.tmux ? `${s.tmux.session}:${s.tmux.paneId}` : s.delivery === "vscode" ? "vscode" : "-";
}

/** ps 형식 표. 보낼 수 없는 세션은 흐리게. */
export function renderSessionTable(snap: SessionSnapshot, style: Style = plain): string {
  const header = ["NAME", "STATUS", "PANE", "PID", "CWD", "BRANCH"];
  const rows = snap.sessions.map((s) => [
    truncate(s.name, 32),
    statusText(s),
    paneText(s),
    s.pid === undefined ? "-" : String(s.pid),
    truncate(tildify(s.cwd), 48),
    s.git?.branch ?? "-",
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]!))));
  const lines = [style.dim(header.map((h, i) => pad(h, widths[i]!)).join("  ").trimEnd())];
  snap.sessions.forEach((s, idx) => {
    const cells = rows[idx]!.map((c, i) => pad(c, widths[i]!));
    const code = statusColor(s);
    cells[1] = code === -1 ? style.accent(cells[1]!) : style.color(cells[1]!, code);
    const line = cells.join("  ").trimEnd();
    lines.push(s.dispatchable ? line : style.dim(line));
  });
  const sendable = snap.sessions.filter((s) => s.dispatchable).length;
  const footer = [`${snap.sessions.length} sessions`, `${sendable} sendable`];
  if (!snap.tmuxRunning) footer.push("tmux off");
  lines.push("", style.dim(footer.join(" · ")));
  for (const w of snap.warnings) lines.push(style.color(`! ${w}`, 33));
  return lines.join("\n");
}
