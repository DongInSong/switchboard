// 릴리즈용: 데몬·CLI를 의존성까지 묶은 단일 파일(dist/switchboard.mjs)로 만든다. Node 24+만 있으면 실행된다.
// 사용: pnpm build:daemon && node dist/switchboard.mjs doctor
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/switchboard.mjs");

await build({
  input: resolve(root, "apps/daemon/bin/switchboard.js"),
  platform: "node",
  external: [/^node:/],
  logLevel: "warn",
  output: { file: out, format: "esm", codeSplitting: false },
});

// 실행 줄(#!)이 하나만 맨 앞에 오게
const code = readFileSync(out, "utf8").replace(/^#!.*\n/gm, "");
writeFileSync(out, `#!/usr/bin/env node\n${code}`);
chmodSync(out, 0o755);
const kb = Math.round(readFileSync(out).length / 1024);
console.log(`dist/switchboard.mjs  ${kb} KB`);
