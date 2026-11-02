/**
 * 화면 문구(영어 기본, 한국어). 규칙은 docs/UX.md §6: 1~2단어, 설명은 툴팁.
 * 언어: 설정(storage.local `sb:lang` = auto | en | ko), auto면 브라우저 언어가 ko…이면 한국어.
 * 세션에 넣는 프롬프트 언어도 이걸 따른다(데몬에 lang으로 넘김).
 */

export type Lang = "en" | "ko";
export type LangSetting = "auto" | Lang;
export const LANG_KEY = "sb:lang";

const ko = {
  "status.viewOnly": "보기 전용",
  "status.idle": "유휴",
  "status.busy": "작업 중",
  "status.waiting": "대기",
  "status.unknown": "알 수 없음",
  "action.copy": "복사",
  "action.queue": "예약",
  "action.send": "보내기",
  "paste.hint": "VS Code에서 ctrl+v · enter",
  "reason.source": "소스 일치",
  "reason.devServer": "dev 서버",
  "reason.recent": "최근 수정",
  "reason.topic": "주제",
  "reason.previous": "이전 선택",
  "d.paste": "붙여넣기",
  "d.queued": "예약",
  "d.delivering": "전달",
  "d.working": "작업 중",
  "d.done": "완료",
  "d.failed": "실패",
  "d.cancelled": "취소",
  "d.saved": "저장",
  "wait.busy": "세션 작업 중",
  "wait.waiting": "세션 응답 대기 중",
  "wait.input": "입력칸에 치다 만 글",
  "wait.unknownScreen": "화면 확인 불가",
  "wait.gone": "세션 없음",
  "captureFailed": "캡처 실패",
  "target.shot": "대상 {n} 스크린샷",
  "target.remove": "대상 {n} 빼기",
  "pair.title": "연결",
  "pair.run": "WSL에서",
  "pair.hint": "WSL에서 switchboard pair",
  "pair.expired": "코드 만료",
  "pair.locked": "잠김",
  "pair.wrong": "틀림",
  "ok": "확인",
  "link.closed": "그 요청이 닫혔음",
  "link.attached": "→ {name} 요청에 붙임",
  "err.sessionGone": "세션 없음",
  "err.notDispatchable": "보낼 수 없음",
  "err.failed": "실패",
  "copy.failedRetry": "복사 실패: 칩에서 다시 복사",
  "copy.failed": "복사 실패",
  "region": "영역 {w}×{h} · {name}",
  "elements": "요소 {n}개 · {name}",
  "screenshot": "스크린샷",
  "screenshot.size": "스크린샷 {w}×{h}",
  "screenshot.none": "스크린샷 없음",
  "close": "닫기",
  "placeholder.request": "요청",
  "placeholder.follow": "이어서",
  "conn.lost": "연결 끊김",
  "conn.ok": "연결됨",
  "conn.unpaired": "미연결",
  "conn.down": "연결 안 됨",
  "retry": "다시 시도",
  "sessions.none": "세션 없음",
  "session": "세션",
  "filter": "찾기",
  "group.suggested": "추천",
  "group.all": "전체",
  "linkInto.title": "이 요청을 붙일 곳",
  "thisPage": "이 페이지",
  "thisTab": "이 탭",
  "otherTab": "다른 탭",
  "key.add": "추가",
  "key.add.title": "다른 요소를 이 요청에 덧붙이기(다른 페이지·탭에서 골라도 됨)",
  "key.addFollow.title": "이어서 쓸 요청에 요소 덧붙이기",
  "key.link": "연결",
  "key.link.title": "이 요청을 다른 요청에 참고 대상으로 붙이기",
  "key.preview": "미리보기",
  "send.vscode.title": "프롬프트를 복사하고 VS Code 탭을 띄움 → ctrl+v · enter",
  "copy": "복사",
  "cancel": "취소",
  "reload": "새로고침",
  "follow": "이어서",
  "remote.banner": "{name} 요청에 덧붙이는 중",
  "remote.esc": "· esc 취소",
  "unavailable": "이 페이지에서는 쓸 수 없음",
  "menu.panel": "세션 패널",
  "savedOnly": "저장만 함",
  "sentPrompt": "보낸 내용",
  "history.none": "기록 없음",
  "addr.localOnly": "이 컴퓨터 주소만",
  "addr.invalid": "주소 형식",
  "perm.denied": "권한 거절",
  "set.daemon": "데몬",
  "set.daemon.title": "switchboard 데몬 주소. 이 컴퓨터(127.0.0.1·localhost)만",
  "set.daemonAddr": "데몬 주소",
  "apply": "적용",
  "set.restore": "자동 복원",
  "set.restore.title": "새로고침 뒤 쓰던 팝업을 바로 다시 띄울 사이트. 없으면 다음 선택 때 되살아남",
  "set.restoreAddr": "자동 복원 주소",
  "allSites": "모든 사이트",
  "none": "없음",
  "removeHost": "{host} 빼기",
  "add": "추가",
  "set.shortcut": "단축키",
  "change": "바꾸기",
  "set.daemonConfig": "데몬 설정",
  "set.daemonConfig.title": "포트, 실행 파일, 보관 기간, 추천 가중치, 전달 타이밍",
  "set.language": "언어",
  "lang.auto": "자동",
  "tab.sessions": "세션",
  "tab.history": "기록",
  "tab.settings": "설정",
  "addr": "주소",
  "addr.title": "데몬 주소 바꾸기",
} as const;

export type Key = keyof typeof ko;

const en: Record<Key, string> = {
  "status.viewOnly": "view only",
  "status.idle": "idle",
  "status.busy": "working",
  "status.waiting": "waiting",
  "status.unknown": "unknown",
  "action.copy": "Copy",
  "action.queue": "Queue",
  "action.send": "Send",
  "paste.hint": "In VS Code: ctrl+v · enter",
  "reason.source": "source match",
  "reason.devServer": "dev server",
  "reason.recent": "recent edit",
  "reason.topic": "topic",
  "reason.previous": "last used",
  "d.paste": "paste",
  "d.queued": "queued",
  "d.delivering": "sending",
  "d.working": "working",
  "d.done": "done",
  "d.failed": "failed",
  "d.cancelled": "cancelled",
  "d.saved": "saved",
  "wait.busy": "session is working",
  "wait.waiting": "session is waiting for input",
  "wait.input": "unsent text in the input box",
  "wait.unknownScreen": "can't read the screen",
  "wait.gone": "session gone",
  "captureFailed": "capture failed",
  "target.shot": "target {n} screenshot",
  "target.remove": "remove target {n}",
  "pair.title": "Pair",
  "pair.run": "run",
  "pair.hint": "run switchboard pair in a terminal",
  "pair.expired": "code expired",
  "pair.locked": "locked",
  "pair.wrong": "wrong code",
  "ok": "OK",
  "link.closed": "that request is closed",
  "link.attached": "→ attached to {name}",
  "err.sessionGone": "session gone",
  "err.notDispatchable": "can't send",
  "err.failed": "failed",
  "copy.failedRetry": "copy failed: copy again from the chip",
  "copy.failed": "copy failed",
  "region": "region {w}×{h} · {name}",
  "elements": "{n} elements · {name}",
  "screenshot": "screenshot",
  "screenshot.size": "screenshot {w}×{h}",
  "screenshot.none": "no screenshot",
  "close": "close",
  "placeholder.request": "request",
  "placeholder.follow": "follow up",
  "conn.lost": "disconnected",
  "conn.ok": "connected",
  "conn.unpaired": "not paired",
  "conn.down": "not connected",
  "retry": "Retry",
  "sessions.none": "no sessions",
  "session": "session",
  "filter": "filter",
  "group.suggested": "suggested",
  "group.all": "all",
  "linkInto.title": "attach this request to",
  "thisPage": "this page",
  "thisTab": "this tab",
  "otherTab": "other tab",
  "key.add": "add",
  "key.add.title": "Add another element to this request (any page or tab)",
  "key.addFollow.title": "Add an element to the follow-up",
  "key.link": "link",
  "key.link.title": "Attach this request to another one as a reference",
  "key.preview": "preview",
  "send.vscode.title": "Copies the prompt and brings up the VS Code tab → ctrl+v · enter",
  "copy": "copy",
  "cancel": "cancel",
  "reload": "reload",
  "follow": "Follow up",
  "remote.banner": "adding to {name}",
  "remote.esc": "· esc to cancel",
  "unavailable": "not available on this page",
  "menu.panel": "Sessions panel",
  "savedOnly": "saved only",
  "sentPrompt": "sent prompt",
  "history.none": "no history",
  "addr.localOnly": "this computer only",
  "addr.invalid": "invalid address",
  "perm.denied": "permission denied",
  "set.daemon": "Daemon",
  "set.daemon.title": "switchboard daemon address. This computer only (127.0.0.1, localhost)",
  "set.daemonAddr": "daemon address",
  "apply": "Apply",
  "set.restore": "Auto-restore",
  "set.restore.title": "Sites where open popovers come back right after a reload. Otherwise they come back on the next pick",
  "set.restoreAddr": "auto-restore site",
  "allSites": "all sites",
  "none": "none",
  "removeHost": "remove {host}",
  "add": "Add",
  "set.shortcut": "Shortcut",
  "change": "Change",
  "set.daemonConfig": "Daemon config",
  "set.daemonConfig.title": "Port, executables, retention, ranking weights, delivery timing",
  "set.language": "Language",
  "lang.auto": "auto",
  "tab.sessions": "sessions",
  "tab.history": "history",
  "tab.settings": "settings",
  "addr": "address",
  "addr.title": "Change the daemon address",
};

const CATALOG: Record<Lang, Record<Key, string>> = { ko, en };

export function detectLang(navLang: string | undefined = typeof navigator !== "undefined" ? navigator.language : undefined): Lang {
  return navLang?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function resolveLang(setting: unknown, navLang?: string): Lang {
  return setting === "en" || setting === "ko" ? setting : detectLang(navLang);
}

let current: Lang = detectLang();

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: Key, params?: Record<string, string | number>, lang: Lang = current): string {
  const s = CATALOG[lang][key];
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** 저장된 설정을 읽어 언어를 정한다(오버레이·사이드 패널·백그라운드 공용). */
export async function loadLang(): Promise<Lang> {
  try {
    const s = await browser.storage.local.get(LANG_KEY);
    current = resolveLang(s[LANG_KEY]);
  } catch {
    current = detectLang();
  }
  return current;
}

/** 설정이 바뀌면 알려 준다. 해제 함수를 돌려준다. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local" || !(LANG_KEY in changes)) return;
    current = resolveLang(changes[LANG_KEY]!.newValue);
    fn(current);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export const CATALOGS_FOR_TEST = CATALOG;
