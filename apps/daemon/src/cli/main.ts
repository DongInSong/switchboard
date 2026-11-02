import { parseArgs } from "node:util";
import { SessionRegistry, buildSnapshot, defaultDeps } from "../registry/registry.ts";
import { existsSync } from "node:fs";
import { HELP, getLang, setLang, t } from "../i18n.ts";
import { SettingsError, loadSettings, requireSettings } from "../settings.ts";
import { config } from "./config.ts";
import { renderChecks, runChecks } from "./doctor.ts";
import { launchClaude } from "./launch.ts";
import { native, nativeHost, nativeSummary, stop } from "./native.ts";
import { renderSessionTable, styleFor } from "./format.ts";
import { listRequests, send } from "./requests.ts";
import { clean, pair, start, status } from "./serve.ts";
import { VERSION } from "../config.ts";



async function sessions(flags: { json: boolean; watch: boolean }): Promise<number> {
  const out = process.stdout;
  const style = styleFor(out);
  if (!flags.watch) {
    const snap = await buildSnapshot(defaultDeps(requireSettings()));
    out.write(flags.json ? `${JSON.stringify(snap, null, 2)}\n` : `${renderSessionTable(snap, style)}\n`);
    return 0;
  }
  const registry = new SessionRegistry(defaultDeps(requireSettings()), { intervalMs: 5_000 });
  registry.on("change", (snap) => {
    if (flags.json) {
      out.write(`${JSON.stringify(snap)}\n`);
      return;
    }
    const time = new Date(snap.takenAt).toLocaleTimeString("en-GB");
    out.write(`\x1b[H\x1b[2J${style.dim(time)}\n\n${renderSessionTable(snap, style)}\n`);
  });
  registry.on("error", (e) => process.stderr.write(`! ${e.message}\n`));
  registry.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  registry.stop();
  return 0;
}

async function doctor(): Promise<number> {
  const checks = await runChecks(requireSettings());
  const loaded = loadSettings();
  const custom = loaded.entries.filter((e) => e.source !== "default").map((e) => e.def.key);
  checks.push({ name: "native host", ok: true, detail: nativeSummary() });
  checks.push({
    name: "config",
    ok: true,
    detail: `${loaded.file}${existsSync(loaded.file) ? "" : t("cfg.fileMissing")}${custom.length ? ` · ${t("doc.changed", { keys: custom.join(", ") })}` : ""}${loaded.warnings.length ? ` · ${loaded.warnings.join(", ")}` : ""}`,
  });
  process.stdout.write(`${renderChecks(checks, styleFor(process.stdout))}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    process.stderr.write(`${e.message}\n${t("cfg.fix")}\n`);
    return 2;
  }
}

async function run(argv: string[]): Promise<number> {
  // 설정이 읽히면 그 언어로(설정이 깨졌으면 환경변수 기준 언어로 오류를 보여 준다)
  const loaded = loadSettings();
  if (loaded.settings) setLang(loaded.settings.language);
  // claude 뒤 인자는 전부 claude에 넘긴다(--resume 등). 옵션 파싱 전에 가른다.
  if (argv[0] === "claude") return launchClaude(argv.slice(1), requireSettings());
  // 브라우저가 띄우는 호스트: 브라우저가 넘기는 인자(확장 주소 등)는 무시하고, stdout은 메시지 전용
  if (argv[0] === "native-host") return nativeHost(requireSettings());
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      background: { type: "boolean", default: false },
      browser: { type: "string", multiple: true },
      "extension-id": { type: "string", multiple: true },
      watch: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      port: { type: "string" },
      session: { type: "string" },
      now: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      days: { type: "string" },
      "unsent-hours": { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command] = positionals;
  const style = styleFor(process.stdout);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      process.stderr.write(`${t("main.badPort", { v: values.port })}\n`);
      return 2;
    }
  }
  switch (command) {
    case "start":
      return start({ port, background: values.background }, style);
    case "pair":
      return pair({ port, reset: values.reset }, style);
    case "status":
      return status({ port }, style);
    case "requests":
      return listRequests({ port, json: values.json }, style);
    case "send": {
      const id = Number(positionals[1]);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(`${t("main.usageSend")}\n`);
        return 2;
      }
      return send({ port, id, now: values.now, follow: true, ...(values.session ? { session: values.session } : {}) }, style);
    }
    case "sessions":
      return sessions({ json: values.json, watch: values.watch });
    case "doctor":
      return doctor();
    case "native":
      return native(positionals.slice(1), { apply: values.apply, browsers: values.browser ?? [], extensionIds: values["extension-id"] ?? [] }, style);
    case "stop":
      return stop();
    case "config":
      return config(positionals.slice(1), { json: values.json, all: values.all, ...(port !== undefined ? { port } : {}) }, style);
    case "clean": {
      const num = (v: string | undefined, name: string): number | undefined | null => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          process.stderr.write(`${t("main.badValue", { name, v })}\n`);
          return null;
        }
        return n;
      };
      const days = num(values.days, "days");
      const unsentHours = num(values["unsent-hours"], "unsent-hours");
      if (days === null || unsentHours === null) return 2;
      return clean({ dryRun: values["dry-run"], ...(days !== undefined ? { days } : {}), ...(unsentHours !== undefined ? { unsentHours } : {}) }, style);
    }
    case undefined:
    case "help":
      process.stdout.write(HELP[getLang()](VERSION));
      return 0;
    default:
      process.stderr.write(`${t("main.unknownCmd", { cmd: command })}\n\n${HELP[getLang()](VERSION)}`);
      return 2;
  }
}
