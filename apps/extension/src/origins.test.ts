import { describe, expect, it } from "vitest";
import { normalizeDaemonBase, restoreHosts, restorePatterns } from "./origins.ts";

describe("데몬 주소", () => {
  it("포트만, 호스트:포트, 전체 주소를 받는다", () => {
    expect(normalizeDaemonBase("7600")).toEqual({ ok: true, base: "http://127.0.0.1:7600" });
    expect(normalizeDaemonBase("localhost:7600")).toEqual({ ok: true, base: "http://localhost:7600" });
    expect(normalizeDaemonBase(" http://127.0.0.1:7490/ ")).toEqual({ ok: true, base: "http://127.0.0.1:7490" });
    expect(normalizeDaemonBase("http://[::1]:7490")).toEqual({ ok: true, base: "http://[::1]:7490" });
  });

  it("이 컴퓨터 밖이나 이상한 주소는 받지 않는다(토큰이 새지 않게)", () => {
    expect(normalizeDaemonBase("http://192.168.0.5:7490")).toEqual({ ok: false, error: "not-local" });
    expect(normalizeDaemonBase("example.com")).toEqual({ ok: false, error: "not-local" });
    expect(normalizeDaemonBase("https://127.0.0.1:7490")).toEqual({ ok: false, error: "invalid" });
    expect(normalizeDaemonBase("http://127.0.0.1:7490/v1")).toEqual({ ok: false, error: "invalid" });
    expect(normalizeDaemonBase("http://u@127.0.0.1:7490")).toEqual({ ok: false, error: "invalid" });
    expect(normalizeDaemonBase("::")).toEqual({ ok: false, error: "invalid" });
  });
});

describe("자동 복원 주소", () => {
  it("스킴이 없으면 http·https 둘 다, 포트는 빼고 호스트만", () => {
    expect(restorePatterns("myapp.test:3000")).toEqual(["http://myapp.test/*", "https://myapp.test/*"]);
    expect(restorePatterns("192.168.0.10")).toEqual(["http://192.168.0.10/*", "https://192.168.0.10/*"]);
    expect(restorePatterns("https://staging.example.com/app?x=1")).toEqual(["https://staging.example.com/*"]);
  });

  it("와일드카드·다른 스킴·빈 값은 거절", () => {
    expect(restorePatterns("*")).toBeNull();
    expect(restorePatterns("*.example.com")).toBeNull();
    expect(restorePatterns("file:///etc")).toBeNull();
    expect(restorePatterns("  ")).toBeNull();
  });

  it("허용된 권한을 호스트별로 묶고 데몬 권한은 뺀다", () => {
    const granted = ["http://127.0.0.1:7490/*", "http://localhost:7490/*", "http://localhost/*", "http://127.0.0.1/*", "http://myapp.test/*", "https://myapp.test/*", "<all_urls>"];
    expect(restoreHosts(granted, ["http://127.0.0.1:7490/*", "http://localhost:7490/*"])).toEqual([
      { host: "127.0.0.1", patterns: ["http://127.0.0.1/*"] },
      { host: "localhost", patterns: ["http://localhost/*"] },
      { host: "myapp.test", patterns: ["http://myapp.test/*", "https://myapp.test/*"] },
    ]);
  });
});
