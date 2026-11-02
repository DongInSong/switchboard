/**
 * Claude Code TUI 화면(tmux capture-pane -e)에서 입력칸 상태를 읽는다.
 * 화면 맨 아래의 두 가로선(────) 사이가 입력칸이고 첫 줄이 `❯`로 시작한다.
 * 권한 확인 같은 대화상자가 떠 있으면 이 모양이 아니므로 "unknown" → 절대 입력하지 않는다.
 */

export type InputBox = { state: "empty" | "text" | "unknown"; text: string };

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const RULE = /^\s*─{20,}\s*$/;
const MAX_BOX_LINES = 40;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** `❯` 바로 뒤 첫 글자가 흐림(SGR 2)이나 회색이면 안내 문구(placeholder)다. */
export function isPlaceholderLine(raw: string): boolean {
  const after = raw.slice(raw.indexOf("❯") + 1);
  const lead = /^((?:\x1b\[[0-9;]*m|[\s ])*)/.exec(after)?.[1] ?? "";
  const codes = lead.match(/\x1b\[[0-9;]*m/g) ?? [];
  return codes.some((c) => {
    const params = c.slice(2, -1).split(";");
    return params.includes("2") || params.includes("90") || (params[0] === "38" && params[1] === "5" && Number(params[2]) >= 240 && Number(params[2]) <= 250);
  });
}

export function readInputBox(screen: string): InputBox {
  const raw = screen.replace(/\r/g, "").split("\n");
  const lines = raw.map(stripAnsi);
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i]!)) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return { state: "unknown", text: "" };
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - MAX_BOX_LINES); i--) {
    if (RULE.test(lines[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return { state: "unknown", text: "" };
  const box = lines.slice(top + 1, bottom);
  if (box.length === 0 || !/^\s*❯/.test(box[0]!)) return { state: "unknown", text: "" };
  const first = box[0]!.replace(/^\s*❯[\s ]?/, "");
  const rest = box.slice(1).map((l) => l.replace(/^ {0,2}/, ""));
  const text = [first, ...rest].join("\n").replace(/ /g, " ").trim();
  if (!text) return { state: "empty", text: "" };
  if (rest.every((l) => !l.trim()) && isPlaceholderLine(raw[top + 1]!)) return { state: "empty", text: "" };
  return { state: "text", text };
}

/** 붙여 넣은 내용이 입력칸에 들어갔는지. Claude Code는 긴 붙여넣기를 `[Pasted text #N …]`로 접어 보여 준다. */
export function inputHasPaste(box: InputBox, marker: string): boolean {
  return box.state === "text" && (box.text.includes(marker) || /\[Pasted text #\d+/.test(box.text));
}
