import { describe, expect, it } from "vitest";
import { planLaunch, sessionBase, uniqueName } from "./launch.ts";

describe("switchboard claude", () => {
  const base = { cwd: "/home/u/my.app", claudeBin: "claude", tmuxBin: "tmux", args: ["--resume", "abc"], name: "claude-my-app" };

  it("tmux 안이면 claude를 그대로 실행", () => {
    expect(planLaunch({ ...base, inTmux: true, env: {} })).toEqual({ cmd: "claude", args: ["--resume", "abc"] });
  });

  it("tmux 밖이면 폴더 이름 세션을 만들고, PATH·Claude 관련 변수만 넘긴다", () => {
    const env = { PATH: "/opt/bin:/usr/bin", ANTHROPIC_MODEL: "x", CLAUDE_CONFIG_DIR: "/c", HOME: "/home/u", SECRET_TOKEN: "no", HTTPS_PROXY: "http://p" };
    expect(planLaunch({ ...base, inTmux: false, env })).toEqual({
      cmd: "tmux",
      args: ["new-session", "-s", "claude-my-app", "-c", "/home/u/my.app", "-e", "ANTHROPIC_MODEL=x", "-e", "CLAUDE_CONFIG_DIR=/c", "-e", "HTTPS_PROXY=http://p", "-e", "PATH=/opt/bin:/usr/bin", "--", "claude", "--resume", "abc"],
    });
  });

  it("세션 이름: tmux가 못 받는 글자를 바꾸고, 겹치면 -2, -3", () => {
    expect(sessionBase("/home/u/my.app")).toBe("claude-my-app");
    expect(sessionBase("/home/u/한글 폴더")).toBe("claude-home");
    expect(sessionBase("/")).toBe("claude-home");
    const taken = new Set(["claude-x", "claude-x-2"]);
    expect(uniqueName("claude-x", (n) => taken.has(n))).toBe("claude-x-3");
    expect(uniqueName("claude-y", (n) => taken.has(n))).toBe("claude-y");
  });
});
