import type { Dispatch, ReasonTag, Session, SessionSnapshot, SourceHint, WaitReason } from "@switchboard/protocol";
import { t, type Key } from "../i18n.ts";

/** 화면 문구. 규칙은 docs/UX.md §6: 1~2단어, 설명 문장 없음. */

export type StatusTone = "idle" | "busy" | "waiting" | "off";

export function statusOf(s: Session): { label: string; tone: StatusTone } {
  if (!s.dispatchable) return { label: t("status.viewOnly"), tone: "off" };
  switch (s.status) {
    case "idle":
      return { label: t("status.idle"), tone: "idle" };
    case "busy":
      return { label: t("status.busy"), tone: "busy" };
    case "waiting":
      return { label: t("status.waiting"), tone: "waiting" };
    default:
      return { label: t("status.unknown"), tone: "off" };
  }
}

/** 유휴면 보내기, 바쁘거나 응답 대기면 예약. VS Code 세션은 복사(사용자가 붙여 넣음). */
export function primaryLabel(s: Session | undefined): string {
  if (s?.delivery === "vscode") return t("action.copy");
  return s && s.dispatchable && s.status !== "idle" ? t("action.queue") : t("action.send");
}

/** 띄운 곳 표시(터미널은 기본이라 표시 안 함). */
export function surfaceTag(s: Session): string | null {
  return s.surface === "vscode" ? "VS Code" : null;
}

/** 클립보드에 넣는다. 페이지가 보안 컨텍스트가 아니면(http://192.168…) navigator.clipboard가 없어 execCommand로. */
export async function copyText(text: string, root: Document | ShadowRoot = document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    (root instanceof Document ? root.body : root).append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export const pasteHint = () => t("paste.hint");

export function projectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/** 보낼 수 있는 세션 먼저, 그 안에서는 시작 순서(데몬이 준 순서 유지). */
export function orderedSessions(snap: SessionSnapshot | null): Session[] {
  if (!snap) return [];
  return [...snap.sessions.filter((s) => s.dispatchable), ...snap.sessions.filter((s) => !s.dispatchable)];
}

function pathOf(file: string): string {
  let p = file;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = decodeURIComponent(new URL(p).pathname);
  } catch {
    /* 그대로 */
  }
  return p.replace(/[?#].*$/, "");
}

/** 머리줄용 짧은 위치: "AvatarMenu.tsx:12" (근사치면 ":~12"). 전체 경로는 툴팁. */
export function sourceShort(hint: SourceHint | undefined): { short: string; full: string } | null {
  if (!hint) return null;
  const path = pathOf(hint.file);
  const base = path.split("/").pop() || path;
  const line = hint.line ? `:${hint.lineApprox ? "~" : ""}${hint.line}` : "";
  return { short: `${base}${line}`, full: `${path}${line}` };
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------- 추천·전달


const REASON_KEY: Record<ReasonTag, Key> = {
  "source-match": "reason.source",
  "dev-server": "reason.devServer",
  "recent-edit": "reason.recent",
  topic: "reason.topic",
  "previous-choice": "reason.previous",
};

export const reasonLabel = (r: ReasonTag) => t(REASON_KEY[r]);

export type DispatchTone = "idle" | "busy" | "waiting" | "fail" | "off";

/** 상태 칩 문구. 저장만 한 요청은 dispatch가 없다. */
export function dispatchLabel(d: Dispatch | null): { label: string; tone: DispatchTone } {
  switch (d?.state) {
    case "queued":
      // 기다릴 이유가 아직 없으면 곧 들어가는 중이다. 이유가 생겼을 때만 예약.
      if (d.waitReason === "paste") return { label: t("d.paste"), tone: "waiting" };
      return d.waitReason ? { label: t("d.queued"), tone: "waiting" } : { label: t("d.delivering"), tone: "busy" };
    case "delivering":
      return { label: t("d.delivering"), tone: "busy" };
    case "delivered":
    case "working":
      return { label: t("d.working"), tone: "busy" };
    case "done":
      return { label: t("d.done"), tone: "idle" };
    case "failed":
      return { label: t("d.failed"), tone: "fail" };
    case "cancelled":
      return { label: t("d.cancelled"), tone: "off" };
    default:
      return { label: t("d.saved"), tone: "off" };
  }
}

/** 예약 이유(툴팁). */
const WAIT_KEY: Record<WaitReason, Key> = {
  busy: "wait.busy",
  waiting: "wait.waiting",
  input: "wait.input",
  "unknown-screen": "wait.unknownScreen",
  gone: "wait.gone",
  paste: "paste.hint",
};

export const waitLabel = (w: WaitReason) => t(WAIT_KEY[w]);

export function isFinal(d: Dispatch | null): boolean {
  return !d || d.state === "done" || d.state === "failed" || d.state === "cancelled";
}

/** 경과 시간 "0:42", "12:05", "1:02:03". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
