import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "@switchboard/protocol";
import { t } from "./i18n.ts";

/**
 * 데몬 설정. 우선순위: 환경변수 > 설정 파일 > 기본값.
 * 설정 파일: $SWITCHBOARD_CONFIG, 없으면 $XDG_CONFIG_HOME/switchboard/config.json (~/.config/switchboard/config.json).
 * 파일은 점 표기 키를 중첩 객체로 담는다: {"port": 7600, "retention": {"sentDays": 30}}.
 * Switchboard 자신의 파일만 읽고 쓴다(Claude Code 설정은 건드리지 않음).
 */

type Kind = { type: "int" | "number"; min: number; max: number } | { type: "string" } | { type: "enum"; values: readonly string[] };

export type SettingDef = {
  key: string;
  default: number | string;
  kind: Kind;
  env?: string;
  help: { en: string; ko: string };
  /** 고급: `switchboard config`에서 기본으로 접어 둔다. */
  advanced?: boolean;
};

const int = (min: number, max: number): Kind => ({ type: "int", min, max });
const num = (min: number, max: number): Kind => ({ type: "number", min, max });
const str: Kind = { type: "string" };
const oneOf = (...values: string[]): Kind => ({ type: "enum", values });

export const SETTINGS: readonly SettingDef[] = [
  { key: "language", default: "auto", kind: oneOf("auto", "en", "ko"), env: "SWITCHBOARD_LANG", help: { en: "Default language for CLI text and prompts (auto: LANG)", ko: "CLI 문구·프롬프트 기본 언어 (auto: LANG 환경변수)" } },
  { key: "port", default: DEFAULT_PORT, kind: int(1, 65535), env: "SWITCHBOARD_PORT", help: { en: "Daemon port. Change the daemon address in the extension too", ko: "데몬 포트. 바꾸면 확장 설정의 데몬 주소도 같이" } },
  { key: "claudeBin", default: "claude", kind: str, env: "SWITCHBOARD_CLAUDE_BIN", help: { en: "Claude Code executable", ko: "Claude Code 실행 파일" } },
  { key: "tmuxBin", default: "tmux", kind: str, env: "SWITCHBOARD_TMUX_BIN", help: { en: "tmux executable", ko: "tmux 실행 파일" } },
  { key: "vscode.scheme", default: "vscode", kind: str, env: "SWITCHBOARD_VSCODE_SCHEME", help: { en: "VS Code URL scheme (Insiders: vscode-insiders)", ko: "VS Code 주소 스킴 (Insiders: vscode-insiders)" } },
  { key: "openCommand", default: "auto", kind: str, env: "SWITCHBOARD_OPEN_COMMAND", help: { en: "Command that opens URLs (auto: Windows from WSL, open on macOS, xdg-open on Linux)", ko: "주소를 여는 명령 (auto: WSL은 Windows, macOS open, Linux xdg-open)" } },
  { key: "retention.sentDays", default: 14, kind: num(0, 3650), env: "SWITCHBOARD_RETENTION_DAYS", help: { en: "Days to keep captures of sent requests (0 = forever)", ko: "보낸 요청 캡처 보관 일수 (0 = 무기한)" } },
  { key: "retention.unsentHours", default: 24, kind: num(0, 24 * 365), env: "SWITCHBOARD_UNSENT_HOURS", help: { en: "Hours to keep captures never sent (0 = forever)", ko: "보내지 않은 캡처 보관 시간 (0 = 무기한)" } },
  { key: "recommend.weights.source", default: 0.45, kind: num(0, 1), help: { en: "Ranking weight: source match", ko: "추천 가중치: 소스 일치" }, advanced: true },
  { key: "recommend.weights.devServer", default: 0.3, kind: num(0, 1), help: { en: "Ranking weight: dev server", ko: "추천 가중치: dev 서버" }, advanced: true },
  { key: "recommend.weights.recent", default: 0.15, kind: num(0, 1), help: { en: "Ranking weight: recent edit", ko: "추천 가중치: 최근 수정" }, advanced: true },
  { key: "recommend.weights.topic", default: 0.1, kind: num(0, 1), help: { en: "Ranking weight: topic", ko: "추천 가중치: 주제" }, advanced: true },
  { key: "recommend.weights.previous", default: 0.05, kind: num(0, 1), help: { en: "Ranking weight: last used", ko: "추천 가중치: 이전 선택" }, advanced: true },
  { key: "recommend.recentHalfLifeMinutes", default: 45, kind: num(1, 7 * 24 * 60), help: { en: "Minutes for the recent-edit score to halve", ko: "최근 수정 점수가 반으로 주는 시간(분)" }, advanced: true },
  { key: "dispatch.pasteDelayMs", default: 150, kind: int(0, 10_000), help: { en: "Wait after pasting before reading the screen (ms)", ko: "붙여넣기 뒤 화면을 읽기까지 기다림(ms)" }, advanced: true },
  { key: "dispatch.pasteVisibleMs", default: 1500, kind: int(100, 60_000), help: { en: "Max wait for pasted text to show in the input box (ms)", ko: "붙여넣은 글이 입력칸에 보이기까지 최대(ms)" }, advanced: true },
  { key: "dispatch.verifyTimeoutMs", default: 8000, kind: int(1000, 120_000), help: { en: "Max wait to confirm the submit after Enter (ms)", ko: "Enter 뒤 제출 확인 최대(ms)" }, advanced: true },
  { key: "dispatch.queueTimeoutMinutes", default: 120, kind: num(1, 7 * 24 * 60), help: { en: "Max time a request stays queued (minutes)", ko: "예약 상태 최대 대기(분)" }, advanced: true },
  { key: "dispatch.pasteTimeoutMinutes", default: 30, kind: num(1, 24 * 60), help: { en: "VS Code sessions: max wait for the paste (minutes)", ko: "VS Code 세션: 붙여넣기를 기다리는 최대(분)" }, advanced: true },
  { key: "dispatch.workTimeoutMinutes", default: 360, kind: num(1, 7 * 24 * 60), help: { en: "Max time to track a running request (minutes)", ko: "작업 추적 최대 시간(분)" }, advanced: true },
];

const DEFS = new Map(SETTINGS.map((d) => [d.key, d]));

export type Source = "default" | "file" | "env";
export type Entry = { def: SettingDef; value: number | string; source: Source };

export type Settings = {
  /** auto를 풀어 낸 언어. */
  language: "en" | "ko";
  port: number;
  claudeBin: string;
  tmuxBin: string;
  vscodeScheme: string;
  openCommand: string;
  retention: { days: number; unsentHours: number };
  recommend: { weights: { source: number; devServer: number; recent: number; topic: number; previous: number }; recentHalfLifeMs: number };
  dispatch: { pasteDelayMs: number; pasteVisibleMs: number; verifyTimeoutMs: number; queueTimeoutMs: number; workTimeoutMs: number; pasteTimeoutMs: number };
};

export type Loaded = {
  file: string;
  /** 문제가 없으면 채워진다. */
  settings: Settings | null;
  entries: Entry[];
  /** 값이 잘못됨(데몬을 띄우지 않는다). */
  problems: string[];
  /** 모르는 키 등(무시하고 진행). */
  warnings: string[];
};

export class SettingsError extends Error {
  readonly file: string;
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${t("cfg.error", { file })}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.file = file;
    this.problems = problems;
  }
}

/** auto: LC_ALL > LC_MESSAGES > LANG 이 ko로 시작하면 한국어, 아니면 영어. */
export function resolveLanguage(setting: string, env: NodeJS.ProcessEnv = process.env): "en" | "ko" {
  if (setting === "en" || setting === "ko") return setting;
  const loc = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return loc.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SWITCHBOARD_CONFIG) return env.SWITCHBOARD_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "switchboard", "config.json");
}

/** 값 하나를 검사한다. 글자로 들어온 숫자(환경변수, `config set`)도 받는다. */
export function parseValue(def: SettingDef, raw: unknown): { ok: true; value: number | string } | { ok: false; error: string } {
  const k = def.kind;
  if (k.type === "enum") {
    const v = typeof raw === "string" ? raw.trim() : raw;
    return typeof v === "string" && k.values.includes(v) ? { ok: true, value: v } : { ok: false, error: t("val.oneOf", { values: k.values.join(" | "), raw: JSON.stringify(raw) }) };
  }
  if (k.type === "string") {
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: t("val.empty") };
    return { ok: true, value: raw.trim() };
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return { ok: false, error: t("val.nan", { raw: JSON.stringify(raw) }) };
  if (k.type === "int" && !Number.isInteger(n)) return { ok: false, error: t("val.notInt", { n }) };
  if (n < k.min || n > k.max) return { ok: false, error: t("val.range", { n, min: k.min, max: k.max }) };
  return { ok: true, value: n };
}

function getPath(obj: unknown, key: string): unknown {
  let cur = obj;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 파일 안의 잎 키(점 표기) 목록. 모르는 키를 찾는 데 쓴다. */
function leafKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return prefix ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function readFileJson(file: string): { data: Record<string, unknown>; error?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { data: {} };
    return { data: {}, error: t("file.unreadable", { msg: (e as Error).message }) };
  }
  if (text.trim() === "") return { data: {} };
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { data: {}, error: t("file.notObject") };
    return { data: data as Record<string, unknown> };
  } catch (e) {
    return { data: {}, error: t("file.badJson", { msg: (e as Error).message }) };
  }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env, file = configFile(env)): Loaded {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { data, error } = readFileJson(file);
  if (error) problems.push(error);
  for (const k of leafKeys(data)) if (!DEFS.has(k)) warnings.push(t("cfg.unknownKey", { key: k }));

  const entries: Entry[] = SETTINGS.map((def) => {
    const fromEnv = def.env ? env[def.env] : undefined;
    if (fromEnv !== undefined && fromEnv !== "") {
      const r = parseValue(def, fromEnv);
      if (r.ok) return { def, value: r.value, source: "env" };
      problems.push(`${def.env}: ${r.error}`);
    }
    const fromFile = getPath(data, def.key);
    if (fromFile !== undefined) {
      const r = parseValue(def, fromFile);
      if (r.ok) return { def, value: r.value, source: "file" };
      problems.push(`${def.key}: ${r.error}`);
    }
    return { def, value: def.default, source: "default" };
  });

  const v = (key: string) => entries.find((e) => e.def.key === key)!.value;
  const n = (key: string) => v(key) as number;
  const weights = {
    source: n("recommend.weights.source"),
    devServer: n("recommend.weights.devServer"),
    recent: n("recommend.weights.recent"),
    topic: n("recommend.weights.topic"),
    previous: n("recommend.weights.previous"),
  };
  if (Object.values(weights).every((w) => w === 0)) problems.push(t("weights.zero"));

  const settings: Settings | null =
    problems.length > 0
      ? null
      : {
          language: resolveLanguage(v("language") as string, env),
          port: n("port"),
          claudeBin: v("claudeBin") as string,
          tmuxBin: v("tmuxBin") as string,
          vscodeScheme: v("vscode.scheme") as string,
          openCommand: v("openCommand") as string,
          retention: { days: n("retention.sentDays"), unsentHours: n("retention.unsentHours") },
          recommend: { weights, recentHalfLifeMs: n("recommend.recentHalfLifeMinutes") * 60_000 },
          dispatch: {
            pasteDelayMs: n("dispatch.pasteDelayMs"),
            pasteVisibleMs: n("dispatch.pasteVisibleMs"),
            verifyTimeoutMs: n("dispatch.verifyTimeoutMs"),
            queueTimeoutMs: n("dispatch.queueTimeoutMinutes") * 60_000,
            workTimeoutMs: n("dispatch.workTimeoutMinutes") * 60_000,
            pasteTimeoutMs: n("dispatch.pasteTimeoutMinutes") * 60_000,
          },
        };
  return { file, settings, entries, problems, warnings };
}

let cached: Settings | undefined;

/** 문제가 있으면 SettingsError. CLI 진입점에서 한 번 잡아 보여 준다. */
export function requireSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  if (env === process.env && cached) return cached;
  const l = loadSettings(env);
  if (!l.settings) throw new SettingsError(l.file, l.problems);
  if (env === process.env) cached = l.settings;
  return l.settings;
}

function writeJson(file: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 키 하나를 파일에 쓴다. 파일이 JSON으로 읽히지 않으면 덮어쓰지 않는다. */
export function setSetting(key: string, raw: string, file: string): { ok: true; value: number | string } | { ok: false; error: string } {
  const def = DEFS.get(key);
  if (!def) return { ok: false, error: t("cfg.unknownKey", { key }) };
  const r = parseValue(def, raw);
  if (!r.ok) return r;
  const { data, error } = readFileJson(file);
  if (error) return { ok: false, error: t("file.fixManually", { file, error }) };
  let cur: Record<string, unknown> = data;
  const parts = key.split(".");
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = r.value;
  writeJson(file, data);
  return r;
}

/** 키를 파일에서 지운다(기본값으로). 비게 된 묶음도 지운다. */
export function unsetSetting(key: string, file: string): { ok: true; removed: boolean } | { ok: false; error: string } {
  if (!DEFS.has(key)) return { ok: false, error: t("cfg.unknownKey", { key }) };
  const { data, error } = readFileJson(file);
  if (error) return { ok: false, error: t("file.fixManually", { file, error }) };
  const parts = key.split(".");
  const chain: Record<string, unknown>[] = [data];
  for (const part of parts.slice(0, -1)) {
    const next = chain.at(-1)![part];
    if (next === null || typeof next !== "object") return { ok: true, removed: false };
    chain.push(next as Record<string, unknown>);
  }
  const last = parts.at(-1)!;
  if (!(last in chain.at(-1)!)) return { ok: true, removed: false };
  delete chain.at(-1)![last];
  for (let i = chain.length - 1; i > 0; i--) if (Object.keys(chain[i]!).length === 0) delete chain[i - 1]![parts[i - 1]!];
  writeJson(file, data);
  return { ok: true, removed: true };
}

export function findSetting(key: string): SettingDef | undefined {
  return DEFS.get(key);
}
