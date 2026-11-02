// E2E용 가짜 VS Code 확장 세션. tmux 밖에서 돌고, 세션 레지스트리에 entrypoint "claude-vscode"를 남긴다.
// control 파일에 {"seq":N,"paste":"…"}가 오면 사용자가 VS Code 입력칸에 붙여 넣고 Enter 한 것으로 보고
// 대화 기록에 user 줄(origin 없음 + <ide_opened_file> 블록, VS Code 추정 형식)과 응답을 남긴다.
// 사용: node fake-vscode.mjs agents=... claudeDir=... cwd=... control=...
import { appendFileSync, mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
const { agents, claudeDir, cwd, control } = args;
const name = "fake-vscode";
const sessionId = "e2e00000-0000-4000-8000-00000000c0de";
const startedAt = Date.now();
const transcript = join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
mkdirSync(dirname(transcript), { recursive: true });
mkdirSync(join(claudeDir, "sessions"), { recursive: true });
let status = "idle";
let lastSeq = 0;

function publish() {
  const entry = { pid: process.pid, cwd, kind: "interactive", startedAt, sessionId, name, status };
  let list = [];
  try {
    list = JSON.parse(readFileSync(agents, "utf8")).filter((a) => a.pid !== process.pid);
  } catch {}
  writeFileSync(`${agents}.${process.pid}.tmp`, JSON.stringify([...list, entry]));
  renameSync(`${agents}.${process.pid}.tmp`, agents);
  writeFileSync(join(claudeDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, entrypoint: "claude-vscode", kind: "interactive", status, updatedAt: Date.now() }));
}

const line = (o) => appendFileSync(transcript, `${JSON.stringify({ ...o, sessionId, entrypoint: "claude-vscode", timestamp: new Date().toISOString() })}\n`);

watchFile(control, { interval: 100 }, () => {
  let c;
  try {
    c = JSON.parse(readFileSync(control, "utf8"));
  } catch {
    return;
  }
  if (!c.seq || c.seq <= lastSeq || typeof c.paste !== "string") return;
  lastSeq = c.seq;
  line({ type: "user", message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>The user opened the file src/App.tsx in the IDE.</ide_opened_file>" }, { type: "text", text: c.paste }] } });
  status = "busy";
  publish();
  setTimeout(() => {
    const reply = ["VS Code에서 받음", "", "| 파일 | 변경 |", "| --- | --- |", "| src/App.tsx | 버튼 색 |"].join("\n");
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    status = "idle";
    publish();
  }, 1500);
});

publish();
setInterval(() => {}, 1 << 30);
