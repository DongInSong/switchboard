/**
 * 데몬·CLI 문구(영어 기본, 한국어). 언어는 설정 language(auto면 LC_ALL/LC_MESSAGES/LANG).
 * 전달 실패 사유처럼 확장 칩에 보이는 문구는 그 요청의 언어(requests.lang)로 쓴다.
 */

export type Lang = "en" | "ko";

const ko = {
  "src.default": "기본",
  "src.file": "파일",
  "src.env": "환경변수",
  "cfg.hiddenAdvanced": "고급 {n}개는 기본값 (switchboard config --all)",
  "cfg.fileMissing": " (없음 · 기본값)",
  "cfg.unknownKey": "모르는 키: {key}",
  "cfg.usageGet": "사용법: switchboard config get <키>",
  "cfg.usageSet": "사용법: switchboard config set <키> <값>",
  "cfg.usageUnset": "사용법: switchboard config unset <키>",
  "cfg.keys": "키: {keys}",
  "cfg.saved": "저장함",
  "cfg.reset": "기본값으로",
  "cfg.envWins": "환경변수 {env}={value}이 우선 적용 중",
  "cfg.restart": "데몬을 다시 시작하면 적용됨",
  "cfg.portHint": "확장 사이드 패널 3 설정 → 데몬 주소도 같이 바꾸세요",
  "cfg.unknownSub": "알 수 없는 하위 명령: {sub}\n사용법: switchboard config [get|set|unset|path]",
  "cfg.error": "설정 오류 ({file})",
  "cfg.fix": "고치기: switchboard config set <키> <값>, 또는 파일을 직접 수정",
  "val.oneOf": "{values} 중 하나: {raw}",
  "val.empty": "빈 값",
  "val.nan": "숫자가 아님: {raw}",
  "val.notInt": "정수가 아님: {n}",
  "val.range": "범위 밖: {n} ({min}~{max})",
  "file.unreadable": "읽을 수 없음: {msg}",
  "file.notObject": "JSON 객체가 아님",
  "file.badJson": "JSON 형식 오류: {msg}",
  "file.fixManually": "{file}: {error} (직접 고치세요)",
  "weights.zero": "recommend.weights: 모두 0이면 추천할 수 없음",
  "doc.needNode": "v{v} (24 이상 필요)",
  "doc.runFailed": "실행 실패",
  "doc.agents": "{n}개 (실행 중 {live})",
  "doc.needTmux": "{v} (3.2 이상 필요)",
  "doc.panes": "pane {n}개",
  "doc.notRunning": "실행 중 아님",
  "doc.noRegistryDir": "{dir} 없음 (주기 갱신만 사용)",
  "doc.changed": "바꾼 값 {keys}",
  "launch.needTty": "터미널에서 실행하세요 (tmux 세션에 붙어야 함)",
  "launch.noTmux": "tmux를 찾을 수 없음 ({bin}). 설치: sudo apt install tmux / brew install tmux, 경로는 switchboard config set tmuxBin <경로>",
  "launch.failed": "실행 실패: {cmd}: {msg}",
  "main.badPort": "잘못된 포트: {v}",
  "main.usageSend": "사용법: switchboard send <요청번호> [--session 세션키] [--now]",
  "main.badValue": "잘못된 값: --{name} {v}",
  "main.unknownCmd": "알 수 없는 명령: {cmd}",
  "req.failed": "실패: {status}",
  "req.sendFailed": "보내지 못함: {err}",
  "req.pasteVscode": "VS Code 탭에 아래를 붙여 넣고 Enter",
  "serve.noCliToken": "CLI 토큰 없음: 데몬을 먼저 실행하세요 (switchboard start)",
  "serve.already": "이미 실행 중: 127.0.0.1:{port}",
  "serve.configWarn": "! 설정: {w}",
  "serve.portInUse": "포트 사용 중: {port}",
  "serve.cleaned": "정리: 캡처 {n}개 · {bytes}",
  "serve.noExt": "연결된 확장 없음. 다른 터미널에서 {cmd}",
  "serve.ext": "연결된 확장 {n}",
  "clean.would": "지울 대상",
  "clean.did": "지움",
  "clean.summary": "{verb}: 보낸 요청 {sent} · 안 보낸 캡처 {unsent} · 남은 폴더 {orphans}",
  "clean.kept": "남김: 캡처 {n}개 · {bytes}   보관: 보낸 요청 {days}, 안 보낸 캡처 {hours}",
  "clean.forever": "무기한",
  "clean.days": "{n}일",
  "clean.hours": "{n}시간",
  "pair.revoked": "연결 해제: 확장 {n}개",
  "pair.enterWithin": "{secs}초 안에 확장에 입력",
  "pair.daemonOff": "데몬이 꺼져 있음: switchboard start",
  "native.usage": "사용법: switchboard native install|uninstall|status [--apply] [--browser edge|chrome|chromium|brave]",
  "native.noWindows": "Windows %LOCALAPPDATA%를 찾지 못함 (WSL interop 꺼짐?)",
  "native.preview": "미리보기 — 적용하려면 --apply",
  "native.write": "쓰기",
  "native.registry": "레지스트리",
  "native.applied": "등록함. 확장을 새로고침하면 데몬을 켜 두거나 페어링할 필요가 없음",
  "native.removed": "지움",
  "native.installed": "등록됨 (브라우저가 직접 띄움)",
  "native.notInstalled": "등록 안 됨 (선택: switchboard native install --apply)",
  "stop.stopped": "데몬 종료함 (pid {pid})",
  "stop.notRunning": "실행 중인 데몬 없음",
  "dsp.restart": "데몬 재시작으로 확인 못 함",
  "dsp.notDispatchable": "보낼 수 없는 세션(tmux 밖이거나 백그라운드)",
  "dsp.paneMismatch": "tmux pane이 세션과 맞지 않음",
  "dsp.queueTimeout": "대기 시간 초과",
  "dsp.gone": "세션이 없음",
  "dsp.noRequest": "요청 없음",
  "dsp.pasteFailed": "tmux 붙여넣기 실패",
  "dsp.notVisible": "붙여 넣은 내용이 입력칸에 안 보임(입력하지 않음)",
  "dsp.enterFailed": "Enter 전송 실패",
  "dsp.unverified": "제출 확인 안 됨. 터미널에서 직접 확인 필요",
  "dsp.noSessionId": "세션 ID 없음",
  "dsp.pasteTimeout": "붙여 넣지 않음(시간 초과)",
  "dsp.vscodeClosed": "세션이 없음(VS Code 탭이 닫힘)",
  "dsp.trackTimeout": "추적 시간 초과",
  "dsp.endedWhileWorking": "작업 중 세션 종료",
  "dsp.log.vscodeWait": "#{id} → {name} (VS Code, 붙여넣기 기다림)",
  "dsp.log.openFailed": "! #{id} VS Code 창을 못 띄움",
  "dsp.log.pasted": "#{id} 붙여넣음 확인",
  "dsp.log.done": "#{id} 완료",
} as const;

export type Key = keyof typeof ko;

const en: Record<Key, string> = {
  "src.default": "default",
  "src.file": "file",
  "src.env": "env",
  "cfg.hiddenAdvanced": "{n} advanced settings at defaults (switchboard config --all)",
  "cfg.fileMissing": " (not found · defaults)",
  "cfg.unknownKey": "unknown key: {key}",
  "cfg.usageGet": "usage: switchboard config get <key>",
  "cfg.usageSet": "usage: switchboard config set <key> <value>",
  "cfg.usageUnset": "usage: switchboard config unset <key>",
  "cfg.keys": "keys: {keys}",
  "cfg.saved": "saved",
  "cfg.reset": "reset to default",
  "cfg.envWins": "environment variable {env}={value} takes precedence",
  "cfg.restart": "restart the daemon to apply",
  "cfg.portHint": "also change the daemon address in the extension side panel (3 settings)",
  "cfg.unknownSub": "unknown subcommand: {sub}\nusage: switchboard config [get|set|unset|path]",
  "cfg.error": "config error ({file})",
  "cfg.fix": "fix: switchboard config set <key> <value>, or edit the file",
  "val.oneOf": "must be one of {values}: {raw}",
  "val.empty": "empty value",
  "val.nan": "not a number: {raw}",
  "val.notInt": "not an integer: {n}",
  "val.range": "out of range: {n} ({min}–{max})",
  "file.unreadable": "can't read: {msg}",
  "file.notObject": "not a JSON object",
  "file.badJson": "invalid JSON: {msg}",
  "file.fixManually": "{file}: {error} (fix it manually)",
  "weights.zero": "recommend.weights: all zero, nothing to rank",
  "doc.needNode": "v{v} (24+ required)",
  "doc.runFailed": "failed to run",
  "doc.agents": "{n} (running {live})",
  "doc.needTmux": "{v} (3.2+ required)",
  "doc.panes": "{n} panes",
  "doc.notRunning": "not running",
  "doc.noRegistryDir": "{dir} missing (polling only)",
  "doc.changed": "changed: {keys}",
  "launch.needTty": "run this in a terminal (it attaches to a tmux session)",
  "launch.noTmux": "tmux not found ({bin}). Install it (sudo apt install tmux / brew install tmux) or set the path: switchboard config set tmuxBin <path>",
  "launch.failed": "failed to run {cmd}: {msg}",
  "main.badPort": "invalid port: {v}",
  "main.usageSend": "usage: switchboard send <request-id> [--session KEY] [--now]",
  "main.badValue": "invalid value: --{name} {v}",
  "main.unknownCmd": "unknown command: {cmd}",
  "req.failed": "failed: {status}",
  "req.sendFailed": "could not send: {err}",
  "req.pasteVscode": "Paste the following into the VS Code tab and press Enter",
  "serve.noCliToken": "no CLI token: start the daemon first (switchboard start)",
  "serve.already": "already running: 127.0.0.1:{port}",
  "serve.configWarn": "! config: {w}",
  "serve.portInUse": "port in use: {port}",
  "serve.cleaned": "cleaned: {n} captures · {bytes}",
  "serve.noExt": "no paired extension. In another terminal: {cmd}",
  "serve.ext": "paired extensions: {n}",
  "clean.would": "would remove",
  "clean.did": "removed",
  "clean.summary": "{verb}: sent {sent} · unsent {unsent} · orphan folders {orphans}",
  "clean.kept": "kept: {n} captures · {bytes}   retention: sent {days}, unsent {hours}",
  "clean.forever": "forever",
  "clean.days": "{n}d",
  "clean.hours": "{n}h",
  "pair.revoked": "unpaired: {n} extensions",
  "pair.enterWithin": "enter it in the extension within {secs}s",
  "pair.daemonOff": "daemon is not running: switchboard start",
  "native.usage": "usage: switchboard native install|uninstall|status [--apply] [--browser edge|chrome|chromium|brave]",
  "native.noWindows": "couldn't find Windows %LOCALAPPDATA% (is WSL interop off?)",
  "native.preview": "preview — run with --apply to write",
  "native.write": "write",
  "native.registry": "registry",
  "native.applied": "registered. Reload the extension; no need to keep the daemon running or pair anymore",
  "native.removed": "removed",
  "native.installed": "installed (the browser starts it)",
  "native.notInstalled": "not installed (optional: switchboard native install --apply)",
  "stop.stopped": "stopped the daemon (pid {pid})",
  "stop.notRunning": "no daemon running",
  "dsp.restart": "unverified after daemon restart",
  "dsp.notDispatchable": "can't send to this session (outside tmux or background)",
  "dsp.paneMismatch": "tmux pane doesn't match the session",
  "dsp.queueTimeout": "timed out waiting",
  "dsp.gone": "session gone",
  "dsp.noRequest": "request not found",
  "dsp.pasteFailed": "tmux paste failed",
  "dsp.notVisible": "pasted text didn't show up in the input box (nothing submitted)",
  "dsp.enterFailed": "failed to send Enter",
  "dsp.unverified": "couldn't confirm the submit. Check the terminal",
  "dsp.noSessionId": "no session ID",
  "dsp.pasteTimeout": "not pasted (timed out)",
  "dsp.vscodeClosed": "session gone (VS Code tab closed)",
  "dsp.trackTimeout": "tracking timed out",
  "dsp.endedWhileWorking": "session ended while working",
  "dsp.log.vscodeWait": "#{id} → {name} (VS Code, waiting for paste)",
  "dsp.log.openFailed": "! #{id} couldn't bring up VS Code",
  "dsp.log.pasted": "#{id} paste confirmed",
  "dsp.log.done": "#{id} done",
};

const CATALOG: Record<Lang, Record<Key, string>> = { ko, en };

function fromEnv(env: NodeJS.ProcessEnv): Lang {
  const s = env.SWITCHBOARD_LANG;
  if (s === "en" || s === "ko") return s;
  const loc = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return loc.toLowerCase().startsWith("ko") ? "ko" : "en";
}

let current: Lang = fromEnv(process.env);

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

export const HELP: Record<Lang, (version: string) => string> = {
  en: (v) => `switchboard ${v}

usage:
  switchboard claude [claude args…]         run Claude Code inside tmux (so Switchboard can send to it)
  switchboard start [--port N]              run the daemon (foreground, Ctrl+C to stop)
  switchboard native install [--apply]      let the browser start Switchboard itself (no daemon to keep running, no pairing)
  switchboard stop                          stop a daemon running in the background
  switchboard pair [--reset]                show a pairing code for the extension / unpair all
  switchboard status                        daemon status
  switchboard requests [--json]             recent requests and delivery state
  switchboard send <id> [--session K] [--now]   send a saved request and follow it until done
  switchboard clean [--dry-run] [--days N] [--unsent-hours N]   remove captures past retention
  switchboard sessions [--json] [--watch]   running Claude Code sessions and tmux panes
  switchboard doctor                        check the environment
  switchboard config [--all|--json]         show settings (value and source: default · file · env)
  switchboard config set <key> <value>      save to the config file (unset <key>: back to default, path: file location)
  switchboard --version

options:
  --json    JSON output
  --watch   redraw on change (Ctrl+C to stop)
  --port    daemon port for this run only (to keep it: switchboard config set port N)
  --all     config: include advanced settings at defaults

precedence: environment variables > config file (~/.config/switchboard/config.json) > defaults
`,
  ko: (v) => `switchboard ${v}

사용법:
  switchboard claude [claude 인자…]         Claude Code를 tmux 안에서 실행 (Switchboard가 보낼 수 있게)
  switchboard start [--port N]              데몬 실행 (포그라운드, Ctrl+C로 종료)
  switchboard native install [--apply]      브라우저가 Switchboard를 직접 띄우게 등록 (데몬 켜 두기·페어링 불필요)
  switchboard stop                          백그라운드 데몬 끄기
  switchboard pair [--reset]                확장 연결 코드 발급 / 모든 연결 해제
  switchboard status                        데몬 상태
  switchboard requests [--json]             최근 요청과 전달 상태
  switchboard send <요청번호> [--session K] [--now]   저장된 요청을 세션에 보내고 끝날 때까지 표시
  switchboard clean [--dry-run] [--days N] [--unsent-hours N]   보관 기간이 지난 캡처 정리
  switchboard sessions [--json] [--watch]   실행 중인 Claude Code 세션과 tmux pane
  switchboard doctor                        실행 환경 점검
  switchboard config [--all|--json]         설정 보기 (값과 출처: 기본·파일·환경변수)
  switchboard config set <키> <값>          설정 파일에 저장 (unset <키>: 기본값으로, path: 파일 위치)
  switchboard --version

옵션:
  --json    JSON으로 출력
  --watch   바뀔 때마다 다시 그림 (Ctrl+C로 종료)
  --port    이번 실행만 데몬 포트 바꾸기 (설정: switchboard config set port N)
  --all     config: 기본값인 고급 설정까지

설정 우선순위: 환경변수 > 설정 파일(~/.config/switchboard/config.json) > 기본값
`,
};
