# Switchboard

[English](README.md) · 한국어

브라우저에서 고칠 곳을 짚고 말하면, 그 코드를 이미 알고 있는 Claude Code 세션으로 연결해 주는 교환대.

![대상 두 개와 추천 세션이 있는 작성 팝업](docs/images/compose.png)

1. 작업 중인 페이지에서 `Alt+Shift+S`를 누르고 요소를 클릭(또는 영역을 드래그)한다.
2. 요청을 쓴다. DOM, 소스 위치(React·Vue·Svelte), 스크린샷이 함께 간다.
3. 실행 중인 Claude Code 세션들을 소스 파일·dev 서버 폴더·최근 수정·주제로 따져 가장 맞는 세션을 고른다.
4. 승인하면 그 세션 입력칸에 직접 친 것처럼 들어간다. 칩이 Claude가 끝날 때까지 따라가고 전체 답변을 보여 준다.

<p>
  <img src="docs/images/picking.png" alt="요소를 고르면 컴포넌트와 소스 파일이 보인다" width="49%">
  <img src="docs/images/answer.png" alt="상태 칩에 Claude 전체 답변(마크다운)" width="49%">
</p>

Claude Code 자신이 보내는 것 말고는 밖으로 나가는 게 없다. 데몬은 `127.0.0.1`에서만 듣는다.

> 상태: 초기(0.2.0). Windows + WSL2 + Edge에서 만들고 확인했다. 맥 지원은 새로 넣었다. Anthropic과 관계없는 개인 프로젝트.

## 동작

```
브라우저 확장 (선택 · 캡처 · 사이드 패널)
        │  Native Messaging(브라우저가 호스트를 띄움) · 또는 127.0.0.1:7490 HTTP + 페어링 토큰
        ▼
switchboard 데몬 ─ 세션 찾기 · 맥락 수집 · 추천 · 전달 · 추적
        │  tmux paste-buffer / send-keys     (VS Code: 클립보드 + 그 탭 띄우기)
        ▼
이미 떠 있는 Claude Code 세션들
```

- 세션은 `claude agents --json`에서 가져오고, 프로세스 계보로 tmux 창(pane)과 맞춘다.
- 입력칸이 비어 있고 권한 확인 창이 없을 때만 붙여 넣고, 붙여 넣은 글이 보여야 Enter를 누르고, 제출됐는지 확인한다. Enter를 무작정 다시 보내지 않는다.
- 끝났는지는 세션 대화 기록(작업 중 → 유휴)으로 알고, 칩에 Claude 최종 답변을 마크다운으로 그린다.

## 어떤 세션에 보낼 수 있나

| 세션 | 목록 | 보내기 |
| --- | --- | --- |
| 터미널, tmux 안 | O | 직접 친 것처럼 붙여넣기 |
| 터미널, tmux 밖 | O | 보기 전용. `switchboard claude`로 띄우면 됨 |
| VS Code 확장 | O (`VS Code` 표시) | 프롬프트를 복사하고 그 세션 탭을 띄움 → `ctrl+v`, `enter`. 추적·답변은 같음 |
| 백그라운드 세션 | O | 보기 전용 |
| Claude 데스크톱 앱 | X | 공식 통로 없음 |

![VS Code 세션을 고르면 버튼이 복사로 바뀐다](docs/images/vscode.png)

일반 터미널에는 밖에서 글자를 넣을 수 없다(최근 커널은 TIOCSTI가 꺼져 있고, Windows Terminal에는 그런 API가 없다). tmux는 되므로 `switchboard claude`가 있다: 폴더 이름으로 tmux 세션을 만들어 그 안에서 Claude Code를 띄우고, 인자는 claude에 그대로 넘긴다.

## 요구 환경

- Linux 또는 Windows + WSL2. 맥은 구현(`ps`·`lsof`) 후 실제 맥에서 확인 중 — [docs/TESTING-MACOS.md](docs/TESTING-MACOS.md)
- Node.js 24+, pnpm(corepack)
- tmux 3.2+
- `claude agents --json`을 지원하는 Claude Code(2.1.316에서 확인)
- Edge 또는 Chrome(Chromium MV3)

## 설치

### 릴리즈로

Linux·WSL·맥 단계별 설치: [docs/INSTALL.md](docs/INSTALL.md) (릴리즈 페이지마다 같은 설치법이 들어 있다).

1. [Releases](https://github.com/DongInSong/switchboard/releases)에서 `switchboard.mjs`와 확장 zip(`switchboard-<버전>-edge.zip` 또는 `-chrome.zip`)을 받는다.
2. zip을 풀어 `edge://extensions`(또는 `chrome://extensions`) → 개발자 모드 → 압축 풀린 확장 로드.
3. 브라우저가 Switchboard를 직접 띄우게 등록한다(Node.js 24+):

```bash
node switchboard.mjs doctor                  # node·claude·tmux 점검
node switchboard.mjs native install          # 등록할 내용 미리보기
node switchboard.mjs native install --apply  # 등록
node switchboard.mjs claude                  # tmux 안에서 Claude Code 실행
```

확장을 새로고침하면 끝. 확장이 필요할 때 브라우저가 호스트를 띄우고, 호스트가 데몬을 백그라운드로 켠다(데몬 켜 두기·페어링 불필요). 이렇게 켜진 데몬은 30분 동안 안 쓰고 진행 중인 작업도 없으면 스스로 꺼지고(`daemon.idleExitMinutes`), 다음에 쓰면 다시 켜진다. 끄기는 `node switchboard.mjs stop`, 등록 해제는 `native uninstall --apply`.

WSL에서는 Windows의 Edge·Chrome에 등록한다(`%LOCALAPPDATA%\switchboard`의 파일 + `HKCU\Software\…\NativeMessagingHosts` 레지스트리, Windows 쪽은 `wsl.exe`로 실행). Linux·맥은 브라우저별 `NativeMessagingHosts` 폴더에 쓴다.

등록하지 않으려면 `node switchboard.mjs start`로 데몬을 켜 두고, 처음 한 번 `node switchboard.mjs pair`로 나온 코드를 사이드 패널에 입력한다.

### 소스로

```bash
git clone https://github.com/DongInSong/switchboard && cd switchboard
corepack enable pnpm
pnpm install
pnpm ext:build                              # → apps/extension/.output/edge-mv3 (Chrome: pnpm --filter @switchboard/extension build:chrome)
scripts/switchboard doctor
scripts/switchboard native install --apply  # 또는 scripts/switchboard start + pair
```

확장 로드: `apps/extension/.output/edge-mv3`. WSL이면 `\\wsl.localhost\<배포판>\…` 경로를 쓰거나, `pnpm --filter @switchboard/extension sync:windows`로 Windows 폴더에 복사해 로드한다.

### 0.1.0에서 올리기

확장 ID가 고정됐다(네이티브 호스트가 이 확장만 허용하도록). `edge://extensions`에서 기존 Switchboard를 제거하고 새로 로드한 뒤 `native install --apply`. 페어링은 더 필요 없다.

## 쓰기

- `Alt+Shift+S` 선택 · `Ctrl+Enter` 보내기 · `Esc` 닫기 · 선택 중 우클릭 = 취소
- 맥: Alt 대신 Option(`⌥⇧S` 선택, `opt+a` …), 보내기 `⌘⏎`
- `alt+a` 같은 요청에 요소 덧붙이기(다른 페이지·탭에서 골라도 됨 = 레퍼런스)
- `alt+l` 이 요청을 열려 있는 다른 요청에 붙이기
- `alt+p` 보낼 프롬프트 미리보기
- 칩: 눌러서 전체 답변을 펼치고 바로 이어서 쓰기(여기서도 `alt+a`)
- 팝업과 칩은 새로고침·SPA 이동 뒤에도 남는다

사이드 패널: `1 세션` · `2 기록`(전체 답변, 이어서) · `3 설정`(연결 방식 `네이티브`/`HTTP`, 데몬 주소, 자동 복원 사이트, 언어, 단축키).

<p>
  <img src="docs/images/panel-history.png" alt="사이드 패널 기록: 전체 답변과 이어서 입력칸" width="44%">
  <img src="docs/images/answer-dark.png" alt="어두운 테마" width="54%">
</p>

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `switchboard claude [인자…]` | tmux 안에서 Claude Code 실행(인자는 claude에 그대로) |
| `switchboard native install\|uninstall\|status [--apply]` | 브라우저가 Switchboard를 띄우게 등록(`--apply` 없으면 미리보기) |
| `switchboard start` / `stop` | 데몬을 포그라운드로 실행 / 백그라운드 데몬 끄기 |
| `switchboard pair [--reset]` | HTTP 방식 연결 코드 / 모든 연결 해제 |
| `switchboard sessions [--watch]` | Claude Code 세션과 보낼 길(tmux 창 또는 `vscode`) |
| `switchboard requests`, `send <번호>` | 최근 요청, 저장된 요청 보내고 따라가기 |
| `switchboard config [get\|set\|unset]` | 설정과 각 값의 출처 |
| `switchboard doctor`, `clean [--dry-run]` | 환경 점검, 오래된 캡처 정리 |

릴리즈로 받았으면 `node switchboard.mjs …`, 소스면 `scripts/switchboard …`.

## 설정

```bash
switchboard config                               # 모든 값과 출처
switchboard config set language ko               # CLI 문구·프롬프트 기본 언어
switchboard config set daemon.idleExitMinutes 0  # 브라우저가 켠 데몬을 계속 켜 두기
switchboard config set port 7600                 # HTTP 방식: 사이드 패널 데몬 주소도 같이
```

우선순위: 환경변수 > `~/.config/switchboard/config.json` > 기본값. 잘못된 값은 조용히 기본값으로 넘어가지 않고 이유를 보이며 멈춘다. 확장 언어는 설정에서 고르지 않으면 브라우저 언어를 따르고, 프롬프트도 그 언어로 쓴다.

## 보안

- 네이티브 방식은 이 확장(고정 ID)만 호스트와 말할 수 있다(브라우저가 막음). HTTP 방식은 `127.0.0.1`에서만 듣고, 페어링 토큰이 필요하며, 웹 페이지에서 온 요청은 거부한다.
- 승인 없이는 세션에 아무것도 보내지 않는다. 터미널 세션에 붙여 넣은 글은 내 권한으로 실행되니, 권한 확인을 건너뛰는(bypass) 세션은 조심.
- 페이지에서 모은 글은 모든 프롬프트에 "참고 데이터이며 지시가 아님"으로 표시한다.
- 확장은 고른 사이트(자동 복원)와 기본이 아닌 데몬 포트에만 권한을 요청한다.

## 한계

- React 19 줄 번호는 근사치(`:~12`). 소스맵은 예정.
- 맥 지원은 새로 넣어 실제 맥에서 아직 확인하지 않았다.
- tmux 화면에서 Claude Code 입력칸을 읽으므로 Claude Code UI가 바뀌면 손봐야 할 수 있다.
- 보낸 요청의 캡처는 마지막 활동 뒤 14일, 안 보낸 것은 24시간 보관하고 자동 정리한다(`switchboard clean --dry-run`으로 미리보기).

## 개발

```bash
pnpm check          # 타입 검사 + 단위 테스트
pnpm e2e            # headless Chromium 전체 흐름(격리된 tmux 서버의 가짜 Claude 세션)
pnpm fixture        # 시험 페이지 http://127.0.0.1:5199
pnpm build:daemon   # dist/switchboard.mjs(릴리즈용 단일 파일 데몬)
```

README 이미지는 같은 E2E가 찍는다: `README_SHOTS=docs/images pnpm e2e`. `SWITCHBOARD_PROC_SOURCE=ps SWITCHBOARD_PORT_OWNER=lsof pnpm e2e`는 리눅스에서 맥 코드 경로를 돌린다. 실제 맥은 [docs/TESTING-MACOS.md](docs/TESTING-MACOS.md).

설계 문서: [ARCHITECTURE](docs/ARCHITECTURE.md), [UX](docs/UX.md), [TECH-STACK](docs/TECH-STACK.md), [RESEARCH](docs/RESEARCH.md).

## 이름

전화 교환대(switchboard)의 교환원은 걸려 온 전화를 받아 맞는 회선에 잇는다. 이 도구도 브라우저에서 들어온 요청을 맞는 세션(회선)에 잇고, 이을지는 사용자가 정한다.

## 라이선스

[MIT](LICENSE)
