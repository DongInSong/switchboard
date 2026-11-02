import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configFile, loadSettings, setSetting, unsetSetting } from "./settings.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "sb-settings-")), "config.json");
const sourceOf = (l: ReturnType<typeof loadSettings>, key: string) => l.entries.find((e) => e.def.key === key)?.source;

describe("settings", () => {
  it("파일이 없으면 기본값", () => {
    const l = loadSettings({}, tmpFile());
    expect(l.problems).toEqual([]);
    expect(l.settings).toMatchObject({ port: 7490, claudeBin: "claude", tmuxBin: "tmux", retention: { days: 14, unsentHours: 24 } });
    expect(l.settings?.recommend.recentHalfLifeMs).toBe(45 * 60_000);
    expect(l.settings?.dispatch.queueTimeoutMs).toBe(120 * 60_000);
  });

  it("환경변수 > 파일 > 기본값", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ port: 7600, retention: { sentDays: 30 }, tmuxBin: "/opt/bin/tmux" }));
    const l = loadSettings({ SWITCHBOARD_PORT: "7700" }, f);
    expect(l.settings).toMatchObject({ port: 7700, tmuxBin: "/opt/bin/tmux", retention: { days: 30, unsentHours: 24 } });
    expect(sourceOf(l, "port")).toBe("env");
    expect(sourceOf(l, "retention.sentDays")).toBe("file");
    expect(sourceOf(l, "retention.unsentHours")).toBe("default");
  });

  it("잘못된 값은 조용히 넘기지 않고 문제로, 모르는 키는 경고로", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ port: 99999, portt: 1, dispatch: { pasteDelayMs: 1.5 } }));
    const l = loadSettings({ SWITCHBOARD_RETENTION_DAYS: "abc" }, f);
    expect(l.settings).toBeNull();
    expect(l.problems).toEqual(["port: 범위 밖: 99999 (1~65535)", "SWITCHBOARD_RETENTION_DAYS: 숫자가 아님: \"abc\"", "dispatch.pasteDelayMs: 정수가 아님: 1.5"]);
    expect(l.warnings).toEqual(["모르는 키: portt"]);
    writeFileSync(f, "{ port: 1 ");
    expect(loadSettings({}, f).problems[0]).toMatch(/^JSON 형식 오류/);
  });

  it("추천 가중치가 모두 0이면 문제", () => {
    const f = tmpFile();
    const w = { source: 0, devServer: 0, recent: 0, topic: 0, previous: 0 };
    writeFileSync(f, JSON.stringify({ recommend: { weights: w } }));
    expect(loadSettings({}, f).problems).toEqual(["recommend.weights: 모두 0이면 추천할 수 없음"]);
  });

  it("set은 중첩 객체로 쓰고 다른 키는 그대로, unset은 비게 된 묶음까지 지운다", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ claudeBin: "/usr/local/bin/claude" }));
    expect(setSetting("dispatch.pasteDelayMs", "200", f)).toEqual({ ok: true, value: 200 });
    expect(setSetting("port", "7600", f)).toEqual({ ok: true, value: 7600 });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ claudeBin: "/usr/local/bin/claude", dispatch: { pasteDelayMs: 200 }, port: 7600 });
    expect(setSetting("port", "x", f)).toEqual({ ok: false, error: "숫자가 아님: \"x\"" });
    expect(setSetting("nope", "1", f)).toEqual({ ok: false, error: "모르는 키: nope" });
    expect(unsetSetting("dispatch.pasteDelayMs", f)).toEqual({ ok: true, removed: true });
    expect(unsetSetting("dispatch.pasteDelayMs", f)).toEqual({ ok: true, removed: false });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ claudeBin: "/usr/local/bin/claude", port: 7600 });
  });

  it("JSON이 깨진 파일은 덮어쓰지 않는다", () => {
    const f = tmpFile();
    writeFileSync(f, "{ broken");
    expect(setSetting("port", "7600", f).ok).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("{ broken");
  });

  it("language: auto면 LC_ALL > LC_MESSAGES > LANG", () => {
    const f = tmpFile();
    expect(loadSettings({ LANG: "ko_KR.UTF-8" }, f).settings?.language).toBe("ko");
    expect(loadSettings({ LANG: "C.UTF-8" }, f).settings?.language).toBe("en");
    expect(loadSettings({ LC_ALL: "en_US.UTF-8", LANG: "ko_KR.UTF-8" }, f).settings?.language).toBe("en");
    expect(loadSettings({ SWITCHBOARD_LANG: "ko", LANG: "C" }, f).settings?.language).toBe("ko");
  });

  it("파일 위치: SWITCHBOARD_CONFIG > XDG_CONFIG_HOME", () => {
    expect(configFile({ SWITCHBOARD_CONFIG: "/x/c.json", XDG_CONFIG_HOME: "/y" })).toBe("/x/c.json");
    expect(configFile({ XDG_CONFIG_HOME: "/y" })).toBe("/y/switchboard/config.json");
  });
});
