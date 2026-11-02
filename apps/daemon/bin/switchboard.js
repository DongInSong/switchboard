#!/usr/bin/env node
// Node 24는 .ts를 타입만 지워서 바로 실행한다(빌드 단계 없음). 그보다 낡은 Node면 알아볼 수 있게 멈춘다.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 23 || (major === 23 && minor < 6)) {
  process.stderr.write(`switchboard: Node 24 이상 필요 (현재 v${process.versions.node}). scripts/switchboard 로 실행하거나 nvm use 24\n`);
  process.exit(1);
}

const { main } = await import("../src/cli/main.ts");
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
