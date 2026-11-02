import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { t } from "../i18n.ts";

/**
 * `switchboard claude [claude 인자…]`: Claude Code를 tmux 안에서 띄운다(Switchboard가 보낼 수 있게).
 * - 이미 tmux 안이면 그냥 claude를 실행한다.
 * - 아니면 이 폴더 이름으로 tmux 세션을 새로 만들어 claude를 띄우고 붙는다. claude가 끝나면 세션도 끝난다.
 * tmux 서버가 이미 떠 있으면 새 세션은 서버의 환경변수를 물려받으므로, PATH와 Claude 관련 변수는 지금 셸의 값을 넘긴다.
 */

/** tmux 세션 이름에 못 쓰는 글자(`.`, `:`, 공백 등)를 바꾼다. */
export function sessionBase(cwd: string): string {
  const b = basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `claude-${b || "home"}`;
}

export function uniqueName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

const PASS_ENV = /^(PATH|CLAUDE_.*|ANTHROPIC_.*|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|AWS_.*|CLOUD_ML_REGION|GOOGLE_.*|VERTEX_.*)$/;

export type LaunchPlan = { cmd: string; args: string[] };

export function planLaunch(o: {
  inTmux: boolean;
  cwd: string;
  claudeBin: string;
  tmuxBin: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  name: string;
}): LaunchPlan {
  if (o.inTmux) return { cmd: o.claudeBin, args: [...o.args] };
  const envArgs = Object.entries(o.env)
    .filter(([k, v]) => v !== undefined && PASS_ENV.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // tmux new-session은 명령 뒤 인자를 셸 없이 그대로 실행한다(3.0+)
  return { cmd: o.tmuxBin, args: ["new-session", "-s", o.name, "-c", o.cwd, ...envArgs, "--", o.claudeBin, ...o.args] };
}

export function launchClaude(args: readonly string[], bins: { claudeBin: string; tmuxBin: string }): number {
  const inTmux = Boolean(process.env.TMUX);
  if (!inTmux && !(process.stdin.isTTY && process.stdout.isTTY)) {
    process.stderr.write(`${t("launch.needTty")}\n`);
    return 2;
  }
  let name = "";
  if (!inTmux) {
    const probe = spawnSync(bins.tmuxBin, ["-V"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      process.stderr.write(`${t("launch.noTmux", { bin: bins.tmuxBin })}\n`);
      return 127;
    }
    const exists = (n: string) => spawnSync(bins.tmuxBin, ["has-session", "-t", `=${n}`], { stdio: "ignore" }).status === 0;
    name = uniqueName(sessionBase(process.cwd()), exists);
  }
  const plan = planLaunch({ inTmux, cwd: process.cwd(), ...bins, args, env: process.env, name });
  const res = spawnSync(plan.cmd, plan.args, { stdio: "inherit" });
  if (res.error) {
    process.stderr.write(`${t("launch.failed", { cmd: plan.cmd, msg: res.error.message })}\n`);
    return 127;
  }
  return res.status ?? 1;
}
