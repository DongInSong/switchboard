// 릴리즈 노트 = 그 버전의 변경 내용 + 설치법(docs/INSTALL.md, Linux·WSL·macOS). 릴리즈마다 같은 설치법이 붙게 한다.
// 사용: node scripts/release-notes.mjs 0.2.2 changes.md > notes.md
//   - <version>, <버전> → 실제 버전, releases/latest/download/ → releases/download/v<버전>/ (그 버전 파일을 받게)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [version, changesFile, ...flags] = process.argv.slice(2);
if (!version || !changesFile) {
  process.stderr.write("usage: node scripts/release-notes.mjs <version> <changes.md> [--install <file>]\n");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i = flags.indexOf("--install");
const installFile = i >= 0 ? resolve(flags[i + 1]) : resolve(root, "docs/INSTALL.md");
const install = readFileSync(installFile, "utf8")
  .replace(/^# .*\n+/, "") // 문서 제목 대신 아래의 '## Install'
  .replace(/^## /gm, "### ")
  .replaceAll("releases/latest/download/", `releases/download/v${version}/`)
  .replaceAll("<version>", version)
  .replaceAll("<버전>", version);
const changes = readFileSync(resolve(changesFile), "utf8").trim();
process.stdout.write(`${changes}\n\n## Install\n\n${install.trim()}\n`);
