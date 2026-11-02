# 조사 기록

2026-11-02 기준 공식 문서, 오픈소스, 이 머신 실측을 정리했다. 설계 판단의 근거가 된 사실만 남겼다.

## 1. Claude Code 공식 인터페이스

### 실행 중인 세션 목록 — `claude agents --json`
- 살아 있는 모든 세션과 아직 작업 중인 백그라운드 세션을 출력한다. 필드: `cwd`, `kind`(`interactive`/`background`), `startedAt`, 프로세스가 살아 있으면 `pid`·`status`(`busy`/`waiting`/`idle`), `waiting`일 때 `waitingFor`(`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`), `sessionId`, `name`.
- 스크립트는 `~/.claude/jobs/<id>/` 같은 파일 대신 이 출력을 폴링하라고 문서가 권장한다.
- 출처: [Agent view](https://code.claude.com/docs/en/agent-view)

### 세션 저장 위치와 포맷
- transcript: `~/.claude/projects/<project>/<session-id>.jsonl` (`<project>` = cwd의 영숫자 외 문자를 `-`로 치환).
- "엔트리 포맷은 Claude Code 내부 포맷이며 버전마다 바뀌므로 직접 파싱하는 스크립트는 깨질 수 있다"고 명시되어 있다. 대안으로 `/export`, `claude -p --resume`, 훅의 `transcript_path`, Agent SDK를 제시한다.
- 백그라운드 세션에는 `claude --resume <session> "prompt"`로 다음 턴 프롬프트를 보낼 수 있다(백그라운드 세션 한정).
- 출처: [Manage sessions](https://code.claude.com/docs/en/sessions)

### 훅
- 이벤트 33종. `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`, `SessionEnd` 등.
- 공통 입력: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` 등. `Stop`에는 `last_assistant_message`가 있다.
- `type: "http"` 훅은 이벤트 JSON을 POST로 보낸다. `headers` + `allowedEnvVars`로 토큰을 주입할 수 있다.
- `async: true` + `asyncRewake: true` 훅은 종료 코드 2로 Claude를 깨우고 stderr를 시스템 리마인더로 전달한다. Bridge 프로젝트에서 유휴 세션 깨우기로 실검증했다.
- `Notification` matcher: `permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed` 등.
- 출처: [Hooks reference](https://code.claude.com/docs/en/hooks)

### 세션 간 메시징
- v2.1.224 이상(WSL 2 포함)에서 같은 머신의 세션끼리 `ListAgents`/`SendMessage`로 메시지를 보낸다. 세션별 Unix 소켓 inbox를 쓰며 경로는 `CLAUDE_CODE_MESSAGING_SOCKET`으로 노출된다.
- 받는 쪽은 "다른 세션이 보낸 메시지"로 취급한다. 승인 대리 불가, 설정 변경 불가, 슬래시 명령 미실행.
- `crossSessionInbound`가 설정되지 않은 경우, bypass 모드인 수신 세션은 메시지를 승인 대화상자로 보류한다.
- 외부 스크립트가 소켓에 쓰는 것을 문서가 언급하지만(자기 자식 프로세스는 검증 후 전달), 메시지 본문 형식은 공개되어 있지 않다.
- **판단**: 사용자 요청은 사용자 권한으로 들어가야 하므로 v1 전달 경로로 쓰지 않는다.
- 출처: [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

### Channels
- MCP 서버가 실행 중인 세션에 이벤트를 push한다. research preview이며 `--channels`로 세션을 시작해야 한다. 직접 만든 채널은 `--dangerously-load-development-channels`가 필요하다.
- **판단**: 기존 세션을 재시작해야 하므로 v1에서 제외하고 지켜본다.
- 출처: [Channels](https://code.claude.com/docs/en/channels)

### Agent SDK 구조화 출력
- TS: `query({ prompt, options: { outputFormat: { type: "json_schema", schema } } })` → 결과 메시지의 `structured_output`. 검증 실패 시 `error_max_structured_output_retries`. 스키마는 JSON Schema draft-07로 검증한다(zod는 `target: "draft-7"`).
- 출처: [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

## 2. 이 머신 실측 (Claude Code v2.1.316, tmux 3.4, WSL2)

| 확인한 것 | 결과 |
| --- | --- |
| `claude agents --json` | tmux 안의 interactive 세션 3개가 `pid`, `cwd`, `name`, `status`와 함께 나옴 (pane 정보는 없음) |
| pid → tmux pane | `148051(claude) → 1377(bash) → tmux server`. `1377`이 `work:@1.%4`의 `pane_pid`와 일치 |
| `~/.claude/sessions/<pid>.json` (내부) | `tmux: "work:@1.%4"`, `status`, `messagingSocketPath`, `peerProtocol` 등. 파일 146개 중 생존 5개 → 생존 판별 필수 |
| 같은 cwd 세션 | `shop-web`에 세션 2개 → 하드 신호만으로는 구분 불가, 주제·최근 파일 신호 필요 |
| WSL 네트워킹 | `.wslconfig`에 networkingMode 없음 = NAT 기본값. localhost 포워딩으로 Windows → WSL 127.0.0.1 접근 (claude-sketch, Bridge에서 사용 중) |
| `rg` | PATH에 없음 → `@vscode/ripgrep` 사용 |
| Node | v20.20.0 (EOL) → 24 LTS 설치 필요 |

### 전달 실험 (2026-11-02)

사용 중인 세션을 건드리지 않도록 tmux에 테스트 세션(`sb-spike`, `claude --model haiku`, `~/project/switchboard`)을 따로 띄워 확인한 뒤 종료했다.

| 단계 | 결과 |
| --- | --- |
| 시작 | `claude agents --json`에 `switchboard-06`, `idle`로 나타남. tmux가 명령을 직접 띄운 pane이라 `pane_pid`가 곧 claude pid |
| `load-buffer` + `paste-buffer -p` (2줄) | 두 줄 모두 입력칸에 머묾, 제출되지 않음, status `idle` 유지 |
| `send-keys Enter` | 0.43초에 `busy`, 3.5초에 `idle`, 화면에 응답 `ok` |
| 검증 | transcript(`~/.claude/projects/-home-me-project-switchboard/<id>.jsonl`)에 마커 `[switchboard #0]` 존재 |
| 입력칸 상태 | 빈 칸은 `❯` 뒤에 NBSP만 있고, 글을 치면 그 뒤에 나타남. `C-u`로 비워짐. 첫 화면에는 흐린 안내 문구(`Try "…"`)가 있어 속성 구분이 필요 |

### 전달 실측 2 (P2, 2026-11-02)

| 확인한 것 | 결과 |
| --- | --- |
| 첫 화면 안내 문구 | `❯\u00a0ESC[2mTry "edit <filepath> to..."ESC[0m` — 흐림 속성 |
| 긴 붙여넣기 | 입력칸에는 `[Pasted text #N …]`로 접힘, 하단에 `paste again to expand` 안내 |
| 대화 기록 | `"content": "\n\n<pasted_content id=\"96cb\">\n…\n</pasted_content id=\"96cb\">\n"`, `origin.kind: "human"`, `promptSource: "typed"` |
| 상태 전환 | `claude agents --json`에서 Enter 후 1초 안에 busy, 응답 끝나면 idle. 레지스트리 파일도 같은 시점에 갱신(디렉터리 감시로 즉시 반영) |
| 왕복 시간 | Haiku 짧은 답 1~5초, 실제 작업(`app-d1`, 화면 설명) 18초 |

## 3. 선행 오픈소스

| 프로젝트 | 하는 일 | 가져올 점 | 차이 |
| --- | --- | --- | --- |
| [stagewise](https://docs.stagewise.io/reference/dom-context-selector) | 브라우저 툴바에서 요소 선택 → HTML, 계산 스타일, 위치·크기, 고유 CSS 선택자를 IDE 에이전트에 전달 | 캡처 필드 구성 | 에디터 확장 하나에 연결, 세션 라우팅 없음 |
| [React Grab](https://github.com/aidenybai/react-grab) | 요소를 가리키고 ⌘C → 파일명, 컴포넌트 스택(`file:line:col`), HTML을 클립보드로 | 컴포넌트 스택 표기 형식, `getElementAtPoint` 히트 테스트, `data-react-grab-ignore` 같은 오버레이 제외 규칙 | 클립보드 복사까지만 |
| [MCP Pointer](https://github.com/etsd-tech/mcp-pointer) | Option+클릭 → 확장이 WebSocket으로 로컬 MCP 서버에 전송 → `get-pointed-element` 도구 | 확장 ↔ 로컬 서버 구조 | 에이전트가 끌어가는 방식(pull), 세션 선택 없음 |
| [code-inspector-plugin](https://github.com/unStone/code-inspector) | 빌드 시 요소에 소스 경로 속성 주입, 클릭하면 에디터 열기 (Vite, webpack, rspack, Next, Nuxt 등) | 빌드 마커 어댑터 | 에디터 열기 용도 |
| [TanStack Devtools Source Inspector](https://tanstack.com/devtools/latest/docs/source-inspector) | Vite 플러그인이 JSX 요소에 `data-tsd-source="file:line:col"` 주입 | 마커 형식 | — |
| [vite-plugin-vue-inspector](https://app.unpkg.com/vite-plugin-vue-inspector@5.3.2/files/dist/index.mjs) | dev 모드에서 `data-v-inspector="path:line:col"` 주입 | Vue 어댑터 | — |
| [Svelte `__svelte_meta`](https://dev.to/petermekhaeil/svelte-components-have-file-location-meta-data-1h0c) | dev 모드에서 노드에 `loc: { file, line, column }` | Svelte 어댑터 | — |
| [bippy](https://app.unpkg.com/bippy@0.5.6/files/dist/source.d.ts) | React 내부 fiber 접근, React 19 `_debugStack` 기반 owner stack | React 19 소스 위치 | React 19에서 `_debugSource` 제거됨 ([react#29092](https://github.com/facebook/react/issues/29092)) |
| [claude-squad](https://github.com/smtg-ai/claude-squad), [claude-tmux](https://github.com/nielsgroen/claude-tmux) | tmux로 여러 에이전트 세션을 만들고 관리, git worktree 격리 | tmux 제어 방식 | 직접 만든 세션만 관리, 기존 세션 라우팅 없음 |

**Switchboard가 새로 하는 것**: 기존 도구는 "맥락을 클립보드나 MCP 도구에 올려 두기" 또는 "새 세션 만들기"에서 멈춘다. Switchboard는 **이미 실행 중인 세션 중 맞는 곳을 골라 승인 후 넣어 주는 라우팅**이 핵심이다.

## 4. tmux 전달 주의점

- `load-buffer` + `paste-buffer -p`를 쓰면 Claude Code가 하나의 붙여넣기로 받으므로 중간 줄바꿈이 제출로 처리되지 않는다. 다만 본문에 bracketed paste 종료 시퀀스가 있으면 붙여넣기가 잘린다 → 제어 문자 제거. ([amux](https://github.com/gkkirsch/amux))
- 붙여넣기 안의 마지막 줄바꿈은 제출되지 않는다. 붙여넣은 뒤 짧게(약 50ms 이상) 기다렸다가 Enter를 따로 보낸다. ([crow PR #274](https://github.com/radiusmethod/crow/pull/274/files))
- 특정 버전에서 tmux pane 안의 제출 키가 무시된다는 보고가 있다(v2.1.119, macOS, 미확인). → 전달 검증 단계가 필수. ([이슈 요약](https://claudeissues.com/issue/52812-bug-v2-1-119-repl-ignores-all-submit-keystrokes-when-stdin-is-a-tmux-pane))

## 5. 브라우저 확장

- WXT `createShadowRootUi`: CSS가 격리된 content script UI. `cssInjectionMode: "ui"`. ([WXT 문서](https://wxt.dev/guide/content-script-ui))
- `captureVisibleTab`: 초당 2회 제한, 보이는 뷰포트만 캡처. 자를 때 배율은 `비트맵 크기 / 뷰포트 크기`로 계산한다. ([제한 상수](https://pub.dev/documentation/chromium/latest/dart_tabs/ChromeTabs/maxCaptureVisibleTabCallsPerSecond.html))
- Edge는 `sidePanel` API를 지원하며 확장 UI를 Edge 사이드바에 띄운다. 권한 이름도 `sidePanel`로 같다. ([Edge 사이드바 문서](https://learn.microsoft.com/microsoft-edge/extensions-chromium/developer-guide/sidebar))
- WXT는 브라우저 타깃별로 따로 빌드한다(예: `edge-mv3`). 사이드 패널은 Chromium이 `side_panel`, Firefox가 `sidebar_action`을 쓴다. ([WXT 다중 브라우저](https://wxt.dev/guide/multiple-browsers), [WXT side panel](https://wxt.dev/entrypoints/sidepanel))
- 확장에서 호스트 권한이 있는 곳으로 보낸 요청은 same-site로 취급되어 `Origin` 헤더가 붙지 않을 수 있다. Edge의 확장 스킴이 `extension://`로 보인다는 사용자 보고도 있다(미확인). → Origin으로 확장을 식별하지 않고 토큰으로 인증한다. ([whatwg/fetch#1878](https://github.com/whatwg/fetch/issues/1878), [Zotero 포럼](https://forums.zotero.org/discussion/comment/357286/))
- WSL2 네트워킹: mirrored 모드는 양방향 localhost를 지원하고, NAT 모드는 Windows → WSL localhost 포워딩이 기본이다. ([Microsoft 문서](https://learn.microsoft.com/en-us/windows/wsl/networking))
