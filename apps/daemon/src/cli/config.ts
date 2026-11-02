import { existsSync } from "node:fs";
import { getLang, t } from "../i18n.ts";
import { SETTINGS, findSetting, loadSettings, setSetting, unsetSetting, type Entry } from "../settings.ts";
import type { Style } from "./format.ts";
import { health } from "./serve.ts";


function show(e: Entry): string {
  return typeof e.value === "string" ? e.value : String(e.value);
}

export function renderConfig(entries: readonly Entry[], style: Style, all: boolean): string {
  const rows = entries.filter((e) => all || !e.def.advanced || e.source !== "default");
  const kw = Math.max(...rows.map((e) => e.def.key.length));
  const vw = Math.max(...rows.map((e) => show(e).length));
  const lines = rows.map((e) => {
    const src = e.source === "default" ? style.dim(t("src.default")) : e.source === "env" ? style.color(`${t("src.env")} ${e.def.env}`, 33) : style.accent(t("src.file"));
    const val = e.source === "default" ? style.dim(show(e).padEnd(vw)) : style.bold(show(e).padEnd(vw));
    return `${e.def.key.padEnd(kw)}  ${val}  ${src}  ${style.dim(e.def.help[getLang()])}`;
  });
  const hidden = entries.length - rows.length;
  if (hidden > 0) lines.push(style.dim(t("cfg.hiddenAdvanced", { n: hidden })));
  return lines.join("\n");
}

/**
 * switchboard config [--all|--json]
 * switchboard config get <키> | set <키> <값> | unset <키> | path
 */
export async function config(args: string[], flags: { json: boolean; all: boolean; port?: number }, style: Style): Promise<number> {
  const [sub, key, ...rest] = args;
  const loaded = loadSettings();
  const out = process.stdout;
  const err = process.stderr;

  if (sub === undefined || sub === "list") {
    if (flags.json) {
      out.write(`${JSON.stringify({ file: loaded.file, problems: loaded.problems, warnings: loaded.warnings, settings: Object.fromEntries(loaded.entries.map((e) => [e.def.key, { value: e.value, source: e.source }])) }, null, 2)}\n`);
      return loaded.problems.length ? 1 : 0;
    }
    out.write(`${style.dim(`${loaded.file}${existsSync(loaded.file) ? "" : t("cfg.fileMissing")}`)}\n\n${renderConfig(loaded.entries, style, flags.all)}\n`);
    for (const p of loaded.problems) err.write(style.color(`! ${p}\n`, 31));
    for (const w of loaded.warnings) err.write(style.color(`! ${w}\n`, 33));
    return loaded.problems.length ? 1 : 0;
  }
  if (sub === "path") {
    out.write(`${loaded.file}\n`);
    return 0;
  }
  if (sub === "get") {
    const e = key ? loaded.entries.find((x) => x.def.key === key) : undefined;
    if (!e) {
      err.write(`${key ? t("cfg.unknownKey", { key }) : t("cfg.usageGet")}\n`);
      return 2;
    }
    out.write(`${show(e)}\n`);
    return 0;
  }
  if (sub === "set" || sub === "unset") {
    if (!key || (sub === "set" && rest.length === 0)) {
      err.write(`${t(sub === "set" ? "cfg.usageSet" : "cfg.usageUnset")}\n${t("cfg.keys", { keys: SETTINGS.map((d) => d.key).join(", ") })}\n`);
      return 2;
    }
    const r = sub === "set" ? setSetting(key, rest.join(" "), loaded.file) : unsetSetting(key, loaded.file);
    if (!r.ok) {
      err.write(`${r.error}\n`);
      return 2;
    }
    const def = findSetting(key)!;
    const now = loadSettings().entries.find((x) => x.def.key === key)!;
    const saved = r.ok && "value" in r ? String(r.value) : show(now);
    out.write(`${key} = ${style.bold(saved)}  ${style.dim(t(sub === "set" ? "cfg.saved" : "cfg.reset"))}\n`);
    if (def.env && now.source === "env") out.write(style.color(`${t("cfg.envWins", { env: def.env, value: show(now) })}\n`, 33));
    if (await health(flags.port ?? loaded.settings?.port ?? Number(def.default))) out.write(style.dim(`${t("cfg.restart")}\n`));
    if (key === "port") out.write(style.dim(`${t("cfg.portHint")}\n`));
    return 0;
  }
  err.write(`${t("cfg.unknownSub", { sub })}\n`);
  return 2;
}
