import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * 주소(vscode://…)를 운영체제에 열게 한다. 브라우저 대신 데몬이 여는 이유: 외부 프로토콜 확인 창 없이 바로 열리고,
 * WSL에서는 Windows 쪽 VS Code로 보내야 하기 때문.
 * - auto: WSL → powershell.exe Start-Process, macOS → open, Linux → xdg-open
 * - 그 밖: 그 명령에 주소를 인자 하나로 넘긴다(셸 없음).
 */

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export type OpenPlan = { cmd: string; args: string[]; cwd?: string };

export function planOpen(uri: string, command: string, platform: NodeJS.Platform = process.platform, wsl = isWsl()): OpenPlan | null {
  if (command !== "auto") return { cmd: command, args: [uri] };
  if (platform === "darwin") return { cmd: "open", args: [uri] };
  if (platform === "win32") return { cmd: "cmd.exe", args: ["/c", "start", '""', uri] };
  if (wsl) {
    // PowerShell 작은따옴표 문자열: ' 는 '' 로. cwd를 Windows 쪽에 두어 UNC 경로 경고를 피한다.
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${uri.replaceAll("'", "''")}'`], ...(existsSync("/mnt/c") ? { cwd: "/mnt/c" } : {}) };
  }
  if (platform === "linux") return { cmd: "xdg-open", args: [uri] };
  return null;
}

export function vscodeSessionUri(scheme: string, sessionId: string): string {
  return `${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
}

export function openUri(uri: string, command: string): Promise<boolean> {
  const plan = planOpen(uri, command);
  if (!plan) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(plan.cmd, plan.args, { stdio: "ignore", ...(plan.cwd ? { cwd: plan.cwd } : {}) });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
