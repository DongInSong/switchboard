import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { defaultPaths } from "../config.ts";
import { t } from "../i18n.ts";
import { runNativeHost } from "../native/host.ts";
import { applyInstall, applyUninstall, installStatus, planInstall, windowsLocalAppData, type NativePlan } from "../native/install.ts";
import { isWsl } from "../opener.ts";
import type { Settings } from "../settings.ts";
import type { Style } from "./format.ts";

function scriptPath(): string {
  const s = process.argv[1] ?? "";
  try {
    return realpathSync(s);
  } catch {
    return s;
  }
}

function makePlan(opts: { browsers: string[]; extensionIds: string[] }): NativePlan | null {
  const wsl = isWsl();
  let windows: { localAppDataWsl: string; localAppDataWin: string; distro: string } | undefined;
  if (wsl) {
    const w = windowsLocalAppData();
    if (!w || !process.env.WSL_DISTRO_NAME) {
      process.stderr.write(`${t("native.noWindows")}\n`);
      return null;
    }
    windows = { ...w, distro: process.env.WSL_DISTRO_NAME };
  }
  return planInstall({
    platform: process.platform,
    wsl,
    home: homedir(),
    dataDir: defaultPaths().dataDir,
    nodePath: process.execPath,
    scriptPath: scriptPath(),
    env: process.env,
    browsers: opts.browsers,
    extensionIds: opts.extensionIds,
    ...(windows ? { windows } : {}),
  });
}

function describePlan(plan: NativePlan, style: Style): string {
  const lines = [`${style.dim(t("native.write"))}  ${plan.launcher.path}`];
  for (const m of plan.manifests) lines.push(`${style.dim(t("native.write"))}  ${m.path}  ${style.dim(m.browser)}`);
  if (plan.windows) {
    lines.push(`${style.dim(t("native.write"))}  ${plan.windows.cmd.path}`, `${style.dim(t("native.write"))}  ${plan.windows.manifest.path}`);
    for (const r of plan.windows.registry) lines.push(`${style.dim(t("native.registry"))}  ${r.key} = ${r.value}`);
  }
  return lines.join("\n");
}

export async function native(args: string[], flags: { apply: boolean; browsers: string[]; extensionIds: string[] }, style: Style): Promise<number> {
  const [sub] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    process.stderr.write(`${t("native.usage")}\n`);
    return 2;
  }
  const plan = makePlan(flags);
  if (!plan) return 1;
  if (sub === "status") {
    const rows = installStatus(plan);
    for (const r of rows) process.stdout.write(`${r.ok ? style.color("ok  ", 32) : style.color("—   ", 33)}  ${r.item}  ${style.dim(r.detail)}\n`);
    return rows.every((r) => r.ok) ? 0 : 1;
  }
  if (!flags.apply) {
    process.stdout.write(`${style.bold(t("native.preview"))}\n${describePlan(plan, style)}\n`);
    return 0;
  }
  if (sub === "install") {
    applyInstall(plan);
    process.stdout.write(`${describePlan(plan, style)}\n${style.color(t("native.applied"), 32)}\n`);
  } else {
    for (const item of applyUninstall(plan)) process.stdout.write(`${style.dim(t("native.removed"))}  ${item}\n`);
  }
  return 0;
}

/** doctor용 한 줄: 등록돼 있는지(선택 사항이라 실패로 치지 않음). */
export function nativeSummary(): string {
  const plan = makePlan({ browsers: [], extensionIds: [] });
  if (!plan) return t("native.noWindows");
  const rows = installStatus(plan);
  return rows.every((r) => r.ok) ? t("native.installed") : t("native.notInstalled");
}

export async function nativeHost(settings: Settings): Promise<number> {
  await runNativeHost({ port: settings.port, paths: defaultPaths(), script: scriptPath() });
  return 0;
}

/** 백그라운드 데몬 끄기(호스트가 켠 데몬 포함). */
export function stop(): number {
  const pidFile = defaultPaths().pidFile;
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    process.stdout.write(`${t("stop.notRunning")}\n`);
    return 1;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`${t("stop.stopped", { pid })}\n`);
    return 0;
  } catch {
    rmSync(pidFile, { force: true });
    process.stdout.write(`${t("stop.notRunning")}\n`);
    return 1;
  }
}
