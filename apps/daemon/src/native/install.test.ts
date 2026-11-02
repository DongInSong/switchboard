import { EXTENSION_ID, NATIVE_HOST_NAME } from "@switchboard/protocol";
import { describe, expect, it } from "vitest";
import { launcherScript, planInstall } from "./install.ts";

const base = {
  home: "/home/u",
  dataDir: "/home/u/.local/share/switchboard",
  nodePath: "/home/u/.nvm/versions/node/v24.22.2/bin/node",
  scriptPath: "/home/u/bin/switchboard.mjs",
  env: { PATH: "/home/u/.local/bin:/usr/bin", ANTHROPIC_API_KEY: "secret", CLAUDE_CONFIG_DIR: "/home/u/.claude", SWITCHBOARD_PORT: "7600", HOME: "/home/u" },
};

describe("native install", () => {
  it("실행 스크립트: PATH 등 필요한 값만 담고 비밀 값은 빼며, 작은따옴표를 이스케이프", () => {
    const s = launcherScript("/n/node", "/s/it's.mjs", base.env);
    expect(s).toContain("export PATH='/home/u/.local/bin:/usr/bin'");
    expect(s).toContain("export CLAUDE_CONFIG_DIR='/home/u/.claude'");
    expect(s).toContain("export SWITCHBOARD_PORT='7600'");
    expect(s).not.toContain("secret");
    expect(s).not.toContain("HOME=");
    expect(s.trim().split("\n").at(-1)).toBe("exec '/n/node' '/s/it'\\''s.mjs' native-host");
  });

  it("Linux: 설치된 브라우저 폴더에만, 매니페스트는 실행 스크립트를 가리키고 이 확장 ID만 허용", () => {
    const plan = planInstall({ ...base, platform: "linux", wsl: false, exists: (p) => p.endsWith("/.config/microsoft-edge") || p.endsWith("/.config/chromium") });
    expect(plan.manifests.map((m) => m.browser)).toEqual(["chromium", "edge"]);
    expect(plan.manifests[1]!.path).toBe(`/home/u/.config/microsoft-edge/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
    const m = JSON.parse(plan.manifests[1]!.content);
    expect(m).toEqual({ name: NATIVE_HOST_NAME, description: "Switchboard native host", path: "/home/u/.local/share/switchboard/native-host.sh", type: "stdio", allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] });
    expect(plan.launcher).toMatchObject({ path: "/home/u/.local/share/switchboard/native-host.sh", mode: 0o700 });
    expect(plan.windows).toBeUndefined();
  });

  it("macOS 폴더, 추가 확장 ID(스토어 빌드 등)", () => {
    const plan = planInstall({ ...base, platform: "darwin", wsl: false, browsers: ["chrome"], extensionIds: ["abcdefghijklmnopabcdefghijklmnop"] });
    expect(plan.manifests[0]!.path).toBe(`/home/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
    expect(JSON.parse(plan.manifests[0]!.content).allowed_origins).toHaveLength(2);
  });

  it("WSL: Windows 쪽 .cmd가 wsl.exe로 실행 스크립트를 돌리고, Edge·Chrome 레지스트리에 매니페스트를 등록", () => {
    const plan = planInstall({
      ...base,
      platform: "linux",
      wsl: true,
      windows: { localAppDataWsl: "/mnt/c/Users/me/AppData/Local", localAppDataWin: "C:\\Users\\me\\AppData\\Local", distro: "Ubuntu" },
    });
    expect(plan.manifests).toEqual([]);
    const w = plan.windows!;
    expect(w.cmd.path).toBe("/mnt/c/Users/me/AppData/Local/switchboard/native-host.cmd");
    // 따옴표 없이: wsl.exe는 -d "Ubuntu"의 따옴표를 이름으로 읽는다(실측)
    expect(w.cmd.content).toBe("@echo off\r\nwsl.exe -d Ubuntu --exec /bin/sh /home/u/.local/share/switchboard/native-host.sh\r\n");
    expect(JSON.parse(w.manifest.content).path).toBe("C:\\Users\\me\\AppData\\Local\\switchboard\\native-host.cmd");
    expect(w.registry).toEqual([
      { key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, value: `C:\\Users\\me\\AppData\\Local\\switchboard\\${NATIVE_HOST_NAME}.json` },
      { key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, value: `C:\\Users\\me\\AppData\\Local\\switchboard\\${NATIVE_HOST_NAME}.json` },
    ]);
  });
});
