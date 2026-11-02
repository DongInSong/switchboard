import { describe, expect, it } from "vitest";
import { planOpen, vscodeSessionUri } from "./opener.ts";

describe("opener", () => {
  const uri = vscodeSessionUri("vscode", "37b35d22-fdef");
  it("VS Code 세션 주소", () => {
    expect(uri).toBe("vscode://anthropic.claude-code/open?session=37b35d22-fdef");
    expect(vscodeSessionUri("vscode-insiders", "a b'")).toBe("vscode-insiders://anthropic.claude-code/open?session=a%20b'");
  });
  it("운영체제별로 여는 명령", () => {
    expect(planOpen(uri, "auto", "darwin", false)).toEqual({ cmd: "open", args: [uri] });
    expect(planOpen(uri, "auto", "linux", false)).toEqual({ cmd: "xdg-open", args: [uri] });
    expect(planOpen("vscode://x?s='a'", "auto", "linux", true)).toMatchObject({ cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process 'vscode://x?s=''a'''"] });
    expect(planOpen(uri, "/usr/local/bin/my-open", "linux", true)).toEqual({ cmd: "/usr/local/bin/my-open", args: [uri] });
  });
});
