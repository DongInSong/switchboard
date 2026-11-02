// Edge가 \\wsl.localhost 경로에서 확장을 못 읽을 때 쓰는 대안: 빌드 결과를 Windows 폴더로 복사한다.
// 사용: pnpm --filter @switchboard/extension sync:windows [대상 폴더(WSL 경로)]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/edge-mv3");
if (!existsSync(src)) {
  console.error("빌드 결과 없음: pnpm --filter @switchboard/extension build");
  process.exit(1);
}
let target = process.argv[2] ?? process.env.SWITCHBOARD_EXT_WINDIR;
if (!target) {
  const profile = execFileSync("cmd.exe", ["/c", "echo %USERPROFILE%"], { encoding: "utf8", cwd: "/mnt/c" }).trim();
  target = `${execFileSync("wslpath", ["-u", profile], { encoding: "utf8" }).trim()}/switchboard-extension`;
}
rmSync(target, { recursive: true, force: true });
cpSync(src, target, { recursive: true });
const win = execFileSync("wslpath", ["-w", target], { encoding: "utf8" }).trim();
console.log(`복사함: ${win}\nEdge에서 이 폴더를 다시 로드하세요.`);
