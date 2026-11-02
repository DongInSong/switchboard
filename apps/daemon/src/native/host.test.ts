import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { NativeFrame, NativeResponse } from "@switchboard/protocol";
import { describe, expect, it } from "vitest";
import { pathsFrom } from "../config.ts";
import { encodeFrame, FrameReader, splitResponse } from "./frames.ts";
import { runNativeHost } from "./host.ts";

describe("frames", () => {
  it("길이(LE 4바이트)+JSON, 잘려 들어와도 모아서 꺼낸다", () => {
    const a = encodeFrame({ id: 1, type: "hello" });
    expect(a.readUInt32LE(0)).toBe(a.length - 4);
    const r = new FrameReader();
    const both = Buffer.concat([a, encodeFrame({ id: 2, 한글: "값" })]);
    expect(r.push(both.subarray(0, 3))).toEqual([]);
    expect(r.push(both.subarray(3, a.length + 2))).toEqual([{ id: 1, type: "hello" }]);
    expect(r.push(both.subarray(a.length + 2))).toEqual([{ id: 2, 한글: "값" }]);
  });

  it("큰 응답은 조각으로, 이어 붙이면 원래 응답", () => {
    const res: NativeResponse = { id: 7, status: 200, contentType: "image/png", bodyB64: "A".repeat(450_000) };
    const frames = splitResponse(res, 200_000);
    expect(frames.map((f) => [f.part, f.parts])).toEqual([[0, 3], [1, 3], [2, 3]]);
    expect(JSON.parse(frames.map((f) => f.data).join(""))).toEqual(res);
    for (const f of frames) expect(encodeFrame(f).length).toBeLessThan(1024 * 1024);
  });
});

describe("native host", () => {
  function setup(opts: { up?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "sb-host-"));
    const paths = pathsFrom(join(dir, "state"), join(dir, "data"));
    let up = opts.up ?? true;
    const calls: { url: string; auth: string | null; body?: string }[] = [];
    let spawned = 0;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/health")) {
        if (!up) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify({ name: "switchboard", version: "0.1.0" }), { headers: { "content-type": "application/json" } });
      }
      const h = new Headers(init?.headers);
      calls.push({ url, auth: h.get("authorization"), body: typeof init?.body === "string" ? init.body : init?.body ? `bytes:${(init.body as Buffer).length}` : undefined });
      if (url.endsWith("/element.png")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json; charset=UTF-8" } });
    }) as typeof fetch;
    const input = new PassThrough();
    const output = new PassThrough();
    const got: NativeResponse[] = [];
    const reader = new FrameReader();
    const parts = new Map<number, string[]>();
    output.on("data", (c: Buffer) => {
      for (const f of reader.push(c) as NativeFrame[]) {
        const list = parts.get(f.id) ?? [];
        list[f.part] = f.data;
        parts.set(f.id, list);
        if (list.filter((x) => x !== undefined).length === f.parts) got.push(JSON.parse(list.join("")) as NativeResponse);
      }
    });
    const done = runNativeHost({
      port: 7591,
      paths,
      script: "/x/switchboard.mjs",
      fetch: fakeFetch,
      input,
      output,
      log: () => undefined,
      sleep: async () => undefined,
      spawnDaemon: () => {
        spawned++;
        up = true;
        // 데몬이 뜨면서 CLI 토큰을 만든다
        writeFileSync(paths.cliTokenFile, "cli-token-1\n");
      },
    });
    return { paths, input, got, calls, done, spawned: () => spawned };
  }

  it("데몬이 꺼져 있으면 켜고, 요청을 CLI 토큰으로 전달(글자·바이너리)", async () => {
    const h = setup({ up: false });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(h.paths.stateDir, { recursive: true });
    h.input.write(encodeFrame({ id: 1, type: "hello" }));
    h.input.write(encodeFrame({ id: 2, type: "http", method: "POST", path: "/v1/requests", contentType: "application/json", body: '{"text":"a"}' }));
    h.input.write(encodeFrame({ id: 3, type: "http", method: "POST", path: "/v1/captures", contentType: "multipart/form-data; boundary=x", bodyB64: Buffer.from("multipart-bytes").toString("base64") }));
    h.input.write(encodeFrame({ id: 4, type: "http", method: "GET", path: "/v1/captures/c1/element.png" }));
    h.input.write(encodeFrame({ id: 5, type: "http", method: "GET", path: "/etc/passwd" }));
    h.input.end();
    await h.done;
    expect(h.spawned()).toBe(1);
    const by = Object.fromEntries(h.got.map((r) => [r.id, r]));
    expect(by[1]).toMatchObject({ status: 200, daemon: { port: 7591, started: true } });
    expect(by[2]).toMatchObject({ status: 201, body: '{"ok":true}' });
    expect(by[4]).toMatchObject({ status: 200, contentType: "image/png", bodyB64: Buffer.from([137, 80, 78, 71]).toString("base64") });
    expect(by[5]).toMatchObject({ status: 400 });
    expect(h.calls.map((c) => [c.url.replace("http://127.0.0.1:7591", ""), c.auth, c.body])).toEqual([
      ["/v1/requests", "Bearer cli-token-1", '{"text":"a"}'],
      ["/v1/captures", "Bearer cli-token-1", "bytes:15"],
      ["/v1/captures/c1/element.png", "Bearer cli-token-1", undefined],
    ]);
  });

  it("데몬이 이미 떠 있으면 켜지 않는다", async () => {
    const h = setup({ up: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(h.paths.stateDir, { recursive: true });
    writeFileSync(h.paths.cliTokenFile, "t");
    h.input.write(encodeFrame({ id: 1, type: "hello" }));
    h.input.end();
    await h.done;
    expect(h.spawned()).toBe(0);
    expect(h.got[0]).toMatchObject({ daemon: { started: false } });
  });
});
