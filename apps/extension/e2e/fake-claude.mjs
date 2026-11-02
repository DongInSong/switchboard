// E2E용 가짜 Claude Code 세션. 격리된 tmux 서버의 pane에서 돈다.
// - 화면: 맨 아래 두 가로선 사이에 `❯` 입력칸 (실제 Claude Code와 같은 모양)
// - bracketed paste를 켜고, 붙여넣기 안의 줄바꿈은 입력으로, 밖의 Enter는 제출로 처리
// - 제출하면: 로그 파일에 기록, 대화 기록(JSONL)에 user/assistant 줄, agents 파일 status busy → idle
// - control 파일 {"dialog":true} 이면 권한 확인 대화상자를 띄우고 status를 waiting으로
// 사용: node fake-claude.mjs agents=... claudeDir=... cwd=... log=... control=...
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const { agents, claudeDir, cwd, log, control } = args;
const name = args.name ?? "fake-e2e";
const sessionId = "e2e00000-0000-4000-8000-000000000001";
const startedAt = Date.now();
const transcript = join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
mkdirSync(dirname(transcript), { recursive: true });
mkdirSync(join(claudeDir, "sessions"), { recursive: true });

let status = "idle";
let dialog = false;
let input = "";
let inPaste = false;
let buf = "";
const history = [];

function publish() {
  const entry = { pid: process.pid, cwd, kind: "interactive", startedAt, sessionId, name, status };
  if (status === "waiting") entry.waitingFor = "permission prompt";
  // 다른 가짜 세션(fake-vscode)과 같은 파일을 쓰므로 내 줄만 갈아 끼우고 원자적으로 쓴다
  let list = [];
  try {
    list = JSON.parse(readFileSync(agents, "utf8")).filter((a) => a.pid !== process.pid);
  } catch {}
  writeFileSync(`${agents}.${process.pid}.tmp`, JSON.stringify([entry, ...list]));
  renameSync(`${agents}.${process.pid}.tmp`, agents);
  // 레지스트리의 디렉터리 감시를 깨운다
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, status, updatedAt: Date.now() }));
}

function render() {
  const out = ["fake-claude e2e", ""];
  for (const h of history.slice(-10)) out.push(h);
  out.push("");
  if (dialog) {
    out.push(" Do you want to make this edit?", " ❯ 1. Yes", "   2. No");
  } else {
    const rule = "─".repeat(80);
    const [first = "", ...rest] = input.split("\n");
    out.push(rule, `❯ ${first}`, ...rest.map((l) => `  ${l}`), rule, `  status ${status}`);
  }
  process.stdout.write(`\x1b[H\x1b[2J${out.join("\r\n")}`);
}

const line = (o) => appendFileSync(transcript, `${JSON.stringify({ ...o, sessionId, timestamp: new Date().toISOString() })}\n`);

function submit() {
  if (dialog || !input.trim()) return;
  const text = input;
  input = "";
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), text })}\n`);
  history.push(`❯ ${text.split("\n")[0]}`);
  line({ type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
  status = "busy";
  publish();
  render();
  setTimeout(() => {
    // 완료 로그가 전체 답변(마크다운 표 포함)을 그대로 보여 주는지 보려고 표와 마지막 줄을 붙인다
    const head = `Received ${text.length} chars.`;
    const reply = [
      "Kept the dropdown inside the viewport: it flips above the avatar when there isn't room below.",
      "",
      "| File | Change |",
      "| --- | --- |",
      "| src/AvatarMenu.tsx | flip + shift with floating-ui |",
      "| src/style.css | max-height: calc(100vh - 64px) |",
      "",
      "Reload the page to check.",
    ].join("\n");
    history.push(`● ${head}`);
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    status = dialog ? "waiting" : "idle";
    publish();
    render();
  }, 2000);
}

const PASTE_ON = "\x1b[200~";
const PASTE_OFF = "\x1b[201~";

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (buf.length) {
    if (buf.startsWith(PASTE_ON)) {
      inPaste = true;
      buf = buf.slice(PASTE_ON.length);
      continue;
    }
    if (buf.startsWith(PASTE_OFF)) {
      inPaste = false;
      buf = buf.slice(PASTE_OFF.length);
      continue;
    }
    // 이스케이프 시퀀스가 잘려 들어왔으면 다음 조각을 기다린다
    if (buf[0] === "\x1b" && buf.length < PASTE_ON.length && (PASTE_ON.startsWith(buf) || PASTE_OFF.startsWith(buf))) break;
    const ch = buf[0];
    buf = buf.slice(1);
    if (inPaste) {
      input += ch === "\r" ? "\n" : ch;
      continue;
    }
    if (ch === "\r") submit();
    else if (ch === "\x03") process.exit(0);
    else if (ch === "\x15") input = "";
    else if (ch === "\x7f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
  }
  render();
});

if (control) {
  watchFile(control, { interval: 150 }, () => {
    try {
      const c = existsSync(control) ? JSON.parse(readFileSync(control, "utf8")) : {};
      dialog = Boolean(c.dialog);
      if (status !== "busy") status = dialog ? "waiting" : "idle";
      publish();
      render();
    } catch {
      /* 쓰는 중 */
    }
  });
}

publish();
render();
