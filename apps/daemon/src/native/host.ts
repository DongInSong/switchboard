import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import type { NativeRequest, NativeResponse } from "@switchboard/protocol";
import { VERSION, type Paths } from "../config.ts";
import { encodeFrame, FrameReader, splitResponse } from "./frames.ts";

/**
 * `switchboard native-host`: 브라우저가 확장의 connectNative로 띄운다. 표준 입출력으로만 말한다(stdout에 로그 금지).
 * 1) 데몬이 꺼져 있으면 백그라운드로 켠다(브라우저를 닫아도 대기열·추적은 계속).
 * 2) 확장의 요청을 CLI 토큰으로 데몬에 전달한다 → 확장은 페어링이 필요 없다.
 * 브라우저가 연결을 끊으면(stdin 끝) 호스트만 끝나고 데몬은 남는다.
 */

export type HostDeps = {
  port: number;
  paths: Paths;
  /** 데몬을 켤 때 쓸 CLI(이 프로세스와 같은 스크립트). */
  script: string;
  fetch?: typeof fetch;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  spawnDaemon?: () => void;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

const TEXT = /^(application\/json|text\/)/;

export async function healthOk(port: number, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && ((await res.json()) as { name?: string }).name === "switchboard";
  } catch {
    return false;
  }
}

export function spawnDaemonDetached(script: string, logFile: string): void {
  const fd = openSync(logFile, "a");
  const child = spawn(process.execPath, [script, "start"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  closeSync(fd);
}

export async function runNativeHost(d: HostDeps): Promise<void> {
  const f = d.fetch ?? fetch;
  const input = d.input ?? process.stdin;
  const output = d.output ?? process.stdout;
  const log = d.log ?? ((m: string) => process.stderr.write(`[switchboard host] ${m}\n`));
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let started = false;
  let ensuring: Promise<boolean> | null = null;

  const ensureDaemon = (): Promise<boolean> =>
    (ensuring ??= (async () => {
      if (await healthOk(d.port, f)) return true;
      log(`daemon not running on ${d.port}, starting`);
      (d.spawnDaemon ?? (() => spawnDaemonDetached(d.script, `${d.paths.stateDir}/daemon.log`)))();
      started = true;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        if (await healthOk(d.port, f)) return true;
      }
      return false;
    })().finally(() => {
      ensuring = null;
    }));

  const token = (): string | null => {
    try {
      return existsSync(d.paths.cliTokenFile) ? readFileSync(d.paths.cliTokenFile, "utf8").trim() : null;
    } catch {
      return null;
    }
  };

  const send = (res: NativeResponse) => {
    for (const frame of splitResponse(res)) output.write(encodeFrame(frame));
  };

  const handle = async (req: NativeRequest): Promise<NativeResponse> => {
    if (!(await ensureDaemon())) return { id: req.id, status: 503, contentType: "application/json", body: JSON.stringify({ error: "daemon-unavailable" }) };
    if (req.type === "hello") return { id: req.id, status: 200, contentType: "application/json", version: VERSION, daemon: { port: d.port, started } };
    const tok = token();
    if (!tok) return { id: req.id, status: 503, contentType: "application/json", body: JSON.stringify({ error: "no-cli-token" }) };
    if (!req.path.startsWith("/v1/")) return { id: req.id, status: 400, contentType: "application/json", body: JSON.stringify({ error: "bad-path" }) };
    const headers: Record<string, string> = { authorization: `Bearer ${tok}` };
    if (req.contentType) headers["content-type"] = req.contentType;
    const body = req.bodyB64 !== undefined ? Buffer.from(req.bodyB64, "base64") : req.body;
    try {
      const res = await f(`http://127.0.0.1:${d.port}${req.path}`, { method: req.method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(60_000) });
      const contentType = res.headers.get("content-type") ?? "";
      const out: NativeResponse = { id: req.id, status: res.status, contentType };
      if (TEXT.test(contentType)) out.body = await res.text();
      else out.bodyB64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return out;
    } catch (e) {
      return { id: req.id, status: 502, contentType: "application/json", body: JSON.stringify({ error: "daemon-error", message: e instanceof Error ? e.message : String(e) }) };
    }
  };

  const reader = new FrameReader();
  const pending = new Set<Promise<void>>();
  await new Promise<void>((resolve) => {
    input.on("data", (chunk: Buffer) => {
      let msgs: unknown[];
      try {
        msgs = reader.push(chunk);
      } catch (e) {
        log(`bad frame: ${e instanceof Error ? e.message : String(e)}`);
        resolve();
        return;
      }
      for (const m of msgs) {
        const p = handle(m as NativeRequest)
          .then(send)
          .catch((e: unknown) => log(`request failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => pending.delete(p));
        pending.add(p);
      }
    });
    input.on("end", () => resolve());
    input.on("close", () => resolve());
  });
  await Promise.all(pending);
}
