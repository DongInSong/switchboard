import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@switchboard/protocol";

/**
 * `switchboard native install`: 브라우저가 호스트를 찾을 수 있게 등록한다.
 * - 실행 스크립트(launcher): 브라우저는 셸 설정 없이 호스트를 띄우므로, 지금 셸의 PATH 등을 담아 node로 호스트를 실행한다.
 * - 호스트 매니페스트: 브라우저별 NativeMessagingHosts 폴더(Linux·macOS) 또는 Windows 레지스트리(WSL에서 Windows 브라우저용).
 * 기본은 미리보기, --apply일 때만 쓴다(브라우저 설정을 건드리므로).
 */

export type FileWrite = { path: string; content: string; mode?: number };
export type RegistryKey = { key: string; value: string };

export type NativePlan = {
  launcher: FileWrite;
  /** Linux·macOS 브라우저 폴더의 매니페스트 */
  manifests: (FileWrite & { browser: string })[];
  /** WSL에서 Windows 브라우저용 */
  windows?: { cmd: FileWrite; manifest: FileWrite; manifestWinPath: string; registry: RegistryKey[] };
};

export type PlanInput = {
  platform: NodeJS.Platform;
  wsl: boolean;
  home: string;
  dataDir: string;
  nodePath: string;
  scriptPath: string;
  env: NodeJS.ProcessEnv;
  extensionIds?: string[];
  /** 고른 브라우저만(없으면 설치된 것 전부, 하나도 없으면 아는 것 전부). */
  browsers?: string[];
  exists?: (path: string) => boolean;
  /** WSL: Windows 쪽 %LOCALAPPDATA%의 두 표기(WSL 경로, Windows 경로)와 배포판 이름 */
  windows?: { localAppDataWsl: string; localAppDataWin: string; distro: string };
};

const LINUX_DIRS: Record<string, string> = {
  chrome: ".config/google-chrome",
  "chrome-beta": ".config/google-chrome-beta",
  chromium: ".config/chromium",
  edge: ".config/microsoft-edge",
  "edge-beta": ".config/microsoft-edge-beta",
  brave: ".config/BraveSoftware/Brave-Browser",
};

const MAC_DIRS: Record<string, string> = {
  chrome: "Library/Application Support/Google/Chrome",
  "chrome-beta": "Library/Application Support/Google/Chrome Beta",
  chromium: "Library/Application Support/Chromium",
  edge: "Library/Application Support/Microsoft Edge",
  brave: "Library/Application Support/BraveSoftware/Brave-Browser",
};

const WIN_REG: Record<string, string> = {
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
};

/** 호스트가 데몬을 켤 때 필요한 것만 담는다(비밀 값은 담지 않음). */
const KEEP_ENV = /^(PATH|LANG|LC_ALL|LC_MESSAGES|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|SWITCHBOARD_[A-Z_]+)$/;

const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcherScript(nodePath: string, scriptPath: string, env: NodeJS.ProcessEnv): string {
  const exports = Object.entries(env)
    .filter(([k, v]) => v !== undefined && v !== "" && KEEP_ENV.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}=${sq(v!)}`);
  return [
    "#!/bin/sh",
    "# Created by `switchboard native install`. The browser runs this to start the Switchboard native host.",
    ...exports,
    `exec ${sq(nodePath)} ${sq(scriptPath)} native-host`,
    "",
  ].join("\n");
}

export function hostManifest(path: string, extensionIds: readonly string[]): string {
  return `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: "Switchboard native host",
      path,
      type: "stdio",
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;
}

export function planInstall(p: PlanInput): NativePlan {
  const exists = p.exists ?? existsSync;
  const ids = [...new Set([EXTENSION_ID, ...(p.extensionIds ?? [])])];
  const launcherPath = join(p.dataDir, "native-host.sh");
  const launcher: FileWrite = { path: launcherPath, content: launcherScript(p.nodePath, p.scriptPath, p.env), mode: 0o700 };
  const manifestName = `${NATIVE_HOST_NAME}.json`;

  // WSL: 브라우저는 Windows에 있다 → Windows 쪽 .cmd가 wsl.exe로 launcher를 실행
  if (p.wsl && p.windows) {
    const w = p.windows;
    if (!/^[\w.-]+$/.test(w.distro)) throw new Error(`unexpected WSL distro name: ${w.distro}`);
    const browsers = (p.browsers?.length ? p.browsers : ["edge", "chrome"]).filter((b) => WIN_REG[b]);
    const dirWsl = `${w.localAppDataWsl}/switchboard`;
    const dirWin = `${w.localAppDataWin}\\switchboard`;
    const cmdWin = `${dirWin}\\native-host.cmd`;
    const manifestWinPath = `${dirWin}\\${manifestName}`;
    return {
      launcher,
      manifests: [],
      windows: {
        // wsl.exe는 명령줄을 직접 해석해서 -d "Ubuntu"처럼 따옴표를 붙이면 이름에 따옴표까지 들어가 WSL_E_DISTRO_NOT_FOUND(실측).
        // 배포판 이름에는 공백이 없으니 그대로, 경로는 공백이 있을 때만 따옴표.
        cmd: { path: `${dirWsl}/native-host.cmd`, content: `@echo off\r\nwsl.exe -d ${w.distro} --exec /bin/sh ${/\s/.test(launcherPath) ? `"${launcherPath}"` : launcherPath}\r\n` },
        manifest: { path: `${dirWsl}/${manifestName}`, content: hostManifest(cmdWin, ids) },
        manifestWinPath,
        registry: browsers.map((b) => ({ key: `${WIN_REG[b]}\\${NATIVE_HOST_NAME}`, value: manifestWinPath })),
      },
    };
  }

  const table = p.platform === "darwin" ? MAC_DIRS : LINUX_DIRS;
  let browsers = p.browsers?.length ? p.browsers.filter((b) => table[b]) : Object.keys(table).filter((b) => exists(join(p.home, table[b]!)));
  if (browsers.length === 0) browsers = Object.keys(table);
  return {
    launcher,
    manifests: browsers.map((b) => ({ browser: b, path: join(p.home, table[b]!, "NativeMessagingHosts", manifestName), content: hostManifest(launcherPath, ids) })),
  };
}

// ---------------------------------------------------------------- 실행

function writeFile(f: FileWrite) {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content);
  if (f.mode !== undefined) chmodSync(f.path, f.mode);
}

function reg(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("reg.exe", args, { encoding: "utf8", cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function applyInstall(plan: NativePlan): string[] {
  const done: string[] = [];
  writeFile(plan.launcher);
  done.push(plan.launcher.path);
  for (const m of plan.manifests) {
    writeFile(m);
    done.push(m.path);
  }
  if (plan.windows) {
    writeFile(plan.windows.cmd);
    writeFile(plan.windows.manifest);
    done.push(plan.windows.cmd.path, plan.windows.manifest.path);
    for (const r of plan.windows.registry) {
      const res = reg(["add", r.key, "/ve", "/t", "REG_SZ", "/d", r.value, "/f"]);
      if (!res.ok) throw new Error(`reg add ${r.key}: ${res.out}`);
      done.push(r.key);
    }
  }
  return done;
}

export function applyUninstall(plan: NativePlan): string[] {
  const done: string[] = [];
  const rm = (path: string) => {
    if (existsSync(path)) {
      rmSync(path);
      done.push(path);
    }
  };
  for (const m of plan.manifests) rm(m.path);
  if (plan.windows) {
    rm(plan.windows.cmd.path);
    rm(plan.windows.manifest.path);
    for (const r of plan.windows.registry) if (reg(["delete", r.key, "/f"]).ok) done.push(r.key);
  }
  rm(plan.launcher.path);
  return done;
}

/** 등록 상태: 파일이 있고 지금 경로를 가리키는지. */
export function installStatus(plan: NativePlan): { item: string; ok: boolean; detail: string }[] {
  const same = (f: FileWrite) => existsSync(f.path) && readFileSync(f.path, "utf8") === f.content;
  const out = [{ item: plan.launcher.path, ok: same(plan.launcher), detail: existsSync(plan.launcher.path) ? (same(plan.launcher) ? "ok" : "stale") : "missing" }];
  for (const m of plan.manifests) out.push({ item: `${m.browser}: ${m.path}`, ok: same(m), detail: existsSync(m.path) ? (same(m) ? "ok" : "stale") : "missing" });
  if (plan.windows) {
    const w = plan.windows;
    out.push({ item: w.manifest.path, ok: same(w.manifest) && same(w.cmd), detail: existsSync(w.manifest.path) ? (same(w.manifest) && same(w.cmd) ? "ok" : "stale") : "missing" });
    for (const r of w.registry) {
      const q = reg(["query", r.key, "/ve"]);
      const ok = q.ok && q.out.includes(r.value);
      out.push({ item: r.key, ok, detail: q.ok ? (ok ? "ok" : "stale") : "missing" });
    }
  }
  return out;
}

/** WSL에서 Windows %LOCALAPPDATA% 찾기. */
export function windowsLocalAppData(): { localAppDataWsl: string; localAppDataWin: string } | null {
  const opts = { encoding: "utf8" as const, cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined };
  const win = spawnSync("cmd.exe", ["/d", "/c", "echo %LOCALAPPDATA%"], opts).stdout?.trim();
  if (!win || win.includes("%")) return null;
  const wslPath = spawnSync("wslpath", ["-u", win], opts).stdout?.trim();
  return wslPath ? { localAppDataWsl: wslPath, localAppDataWin: win } : null;
}
