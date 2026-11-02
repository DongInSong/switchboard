import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import type { Dispatch } from "@switchboard/protocol";
import { ActivityTracker } from "../activity/transcript.ts";
import { Auth } from "../auth.ts";
import { VERSION, defaultPaths, defaultPort, type Paths } from "../config.ts";
import { ContextService } from "../context.ts";
import { Dispatcher } from "../dispatch/dispatcher.ts";
import { TmuxDriver } from "../dispatch/tmux-driver.ts";
import { readStat } from "../registry/proc.ts";
import { SessionRegistry, defaultDeps } from "../registry/registry.ts";
import { claudeConfigDir } from "../registry/registryFile.ts";
import { cleanup, formatBytes } from "../retention.ts";
import { createApp } from "../server.ts";
import { openUri, vscodeSessionUri } from "../opener.ts";
import { t } from "../i18n.ts";
import { shouldIdleExit } from "../idle.ts";
import { loadSettings, requireSettings } from "../settings.ts";
import { Store } from "../store.ts";
import type { Style } from "./format.ts";

export function authFor(paths: Paths): Auth {
  return new Auth({ pairFile: paths.pairFile, tokensFile: paths.tokensFile });
}

export async function health(port: number): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; version?: string };
    return body.name === "switchboard" ? { version: String(body.version) } : null;
  } catch {
    return null;
  }
}

/** CLI가 데몬 API를 부른다(CLI 토큰 사용). */
export async function api<T>(port: number, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const paths = defaultPaths();
  let token: string;
  try {
    token = (await readFile(paths.cliTokenFile, "utf8")).trim();
  } catch {
    throw new Error(t("serve.noCliToken"));
  }
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

function stateLine(d: Dispatch): string {
  const wait = d.waitReason ? ` (${d.waitReason})` : "";
  return `${d.state}${wait}${d.error ? ` · ${d.error}` : ""}`;
}

/** Claude Code 도구 줄처럼: 진행 중 ✻(오렌지), 끝나면 ●(초록/빨강). */
function stateGlyph(d: Dispatch, style: Style): string {
  if (d.state === "done") return style.color("●", 32);
  if (d.state === "failed") return style.color("●", 31);
  if (d.state === "cancelled") return style.dim("●");
  if (d.state === "queued" && d.waitReason) return style.color("◌", 33);
  return style.accent("✻");
}

/** 포그라운드로 데몬을 띄운다. Ctrl+C로 종료. */
export async function start(opts: { port?: number; background?: boolean }, style: Style): Promise<number> {
  const paths = defaultPaths();
  const settings = requireSettings();
  const port = opts.port ?? settings.port;
  if (await health(port)) {
    process.stderr.write(`${t("serve.already", { port })}\n`);
    return 1;
  }
  for (const w of loadSettings().warnings) process.stderr.write(`${t("serve.configWarn", { w })}\n`);
  const registry = new SessionRegistry(defaultDeps(settings));
  const store = new Store(paths.dbFile);
  const auth = authFor(paths);
  await auth.ensureCliToken(paths.cliTokenFile);
  const activity = new ActivityTracker(claudeConfigDir());
  const context = new ContextService({ registry, activity, recommend: settings.recommend });
  const bus = new EventEmitter();
  const time = () => style.dim(new Date().toLocaleTimeString("en-GB"));
  const dispatcher = new Dispatcher({
    store,
    registry,
    tmux: new TmuxDriver({ bin: settings.tmuxBin, ...(process.env.SWITCHBOARD_TMUX_SOCKET ? { socket: process.env.SWITCHBOARD_TMUX_SOCKET } : {}) }),
    config: settings.dispatch,
    openSession: (s) => (s.sessionId ? openUri(vscodeSessionUri(settings.vscodeScheme, s.sessionId), settings.openCommand) : Promise.resolve(false)),
    activity,
    readStat,
    onUpdate: (d) => {
      bus.emit("dispatch", d);
      process.stdout.write(`${time()}  ${stateGlyph(d, style)} #${d.requestId} ${d.sessionName}  ${stateLine(d)}\n`);
    },
    log: (m) => process.stdout.write(`${time()}  ${style.dim("⎿")} ${m}\n`),
  });
  let lastActivity = Date.now();
  const app = createApp({ auth, store, registry, paths, port, context, dispatcher, bus, lang: settings.language, onActivity: () => (lastActivity = Date.now()) });

  registry.on("error", (e) => process.stderr.write(`! registry: ${e.message}\n`));
  let lastSummary = "";
  registry.on("change", (s) => {
    const sendable = s.sessions.filter((x) => x.dispatchable).length;
    const summary = `sessions ${s.sessions.length} · sendable ${sendable}`;
    if (summary !== lastSummary) process.stdout.write(`${time()}  ${style.dim(summary)}\n`);
    lastSummary = summary;
  });

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  const listening = await new Promise<boolean>((resolve) => {
    server.once("listening", () => resolve(true));
    server.once("error", (err: NodeJS.ErrnoException) => {
      process.stderr.write(err.code === "EADDRINUSE" ? `${t("serve.portInUse", { port })}\n` : `! ${err.message}\n`);
      resolve(false);
    });
  });
  if (!listening) {
    store.close();
    return 1;
  }
  registry.start();
  await registry.refresh().catch(() => undefined);
  dispatcher.resume();
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.pidFile, `${process.pid}\n`);

  // 보관 기간이 지난 캡처 정리: 시작할 때 한 번, 그 뒤 6시간마다.
  const policy = settings.retention;
  const sweep = async () => {
    try {
      const r = await cleanup(store, paths.capturesDir, policy, Date.now());
      const n = r.removed.length + r.orphans.length;
      if (n > 0) process.stdout.write(`${time()}  ${style.dim(t("serve.cleaned", { n, bytes: formatBytes(r.freedBytes) }))}\n`);
    } catch (e) {
      process.stderr.write(`! cleanup: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 6 * 60 * 60_000);
  sweepTimer.unref();
  const extensions = await auth.extensionCount();
  process.stdout.write(
    `${style.accent("✻")} ${style.bold("switchboard")} ${style.dim(VERSION)}  ${style.bold(`http://127.0.0.1:${port}`)}\n` +
      style.dim(`data ${paths.dataDir}\n`) +
      (extensions === 0 ? `${t("serve.noExt", { cmd: style.bold("switchboard pair") })}\n` : style.dim(`${t("serve.ext", { n: extensions })}\n`)),
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    // 브라우저가 켠 데몬: 안 쓰면 스스로 끈다(다음에 필요하면 호스트가 다시 켠다)
    if (opts.background && settings.idleExitMs > 0) {
      const idleTimer = setInterval(() => {
        if (shouldIdleExit({ now: Date.now(), lastActivity, idleMs: settings.idleExitMs, activeDispatches: store.activeDispatches().length })) {
          clearInterval(idleTimer);
          process.stdout.write(`${time()}  ${style.dim(t("serve.idleExit", { min: Math.round(settings.idleExitMs / 60_000) }))}\n`);
          resolve();
        }
      }, Math.min(30_000, settings.idleExitMs));
      idleTimer.unref();
    }
  });
  clearInterval(sweepTimer);
  rmSync(paths.pidFile, { force: true });
  dispatcher.stop();
  registry.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  return 0;
}

/** 수동 정리. --dry-run이면 지울 대상만 보여 준다. 데몬이 떠 있어도 안전(SQLite WAL). */
export async function clean(opts: { dryRun: boolean; days?: number; unsentHours?: number }, style: Style): Promise<number> {
  const paths = defaultPaths();
  const base = requireSettings().retention;
  const policy = { days: opts.days ?? base.days, unsentHours: opts.unsentHours ?? base.unsentHours };
  const store = new Store(paths.dbFile);
  try {
    const r = await cleanup(store, paths.capturesDir, policy, Date.now(), { dryRun: opts.dryRun });
    const sent = r.removed.filter((x) => x.sent).length;
    const unsent = r.removed.length - sent;
    const verb = t(opts.dryRun ? "clean.would" : "clean.did");
    const keep = (n: number, unit: "clean.days" | "clean.hours") => (n ? t(unit, { n }) : t("clean.forever"));
    process.stdout.write(
      `${t("clean.summary", { verb, sent, unsent, orphans: r.orphans.length })}  ${style.bold(formatBytes(r.freedBytes))}\n` +
        style.dim(`${t("clean.kept", { n: r.kept.count, bytes: formatBytes(r.kept.bytes), days: keep(policy.days, "clean.days"), hours: keep(policy.unsentHours, "clean.hours") })}\n`),
    );
    return 0;
  } finally {
    store.close();
  }
}

export async function pair(opts: { port?: number; reset: boolean }, style: Style): Promise<number> {
  const paths = defaultPaths();
  const auth = authFor(paths);
  if (opts.reset) {
    const n = await auth.revokeAll();
    process.stdout.write(`${t("pair.revoked", { n })}\n`);
    return 0;
  }
  const { code, expiresAt } = await auth.createPairCode();
  const secs = Math.round((expiresAt - Date.now()) / 1000);
  process.stdout.write(`${style.bold(`${code.slice(0, 3)} ${code.slice(3)}`)}  ${style.dim(t("pair.enterWithin", { secs }))}\n`);
  if (!(await health(opts.port ?? defaultPort()))) {
    process.stdout.write(style.color(`${t("pair.daemonOff")}\n`, 33));
  }
  return 0;
}

export async function status(opts: { port?: number }, style: Style): Promise<number> {
  const port = opts.port ?? defaultPort();
  const h = await health(port);
  const extensions = await authFor(defaultPaths()).extensionCount();
  process.stdout.write(
    `${h ? style.color("running", 32) : style.color("stopped", 31)}  127.0.0.1:${port}${h ? `  v${h.version}` : ""}\n` +
      style.dim(`${t("serve.ext", { n: extensions })}\n`),
  );
  return h ? 0 : 1;
}
