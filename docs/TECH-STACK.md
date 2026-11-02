# 기술 스택

- 문서 상태: 초안 v0.1 (2026-11-02)
- 원칙: 한 언어(TypeScript), 공식 인터페이스, 의존성 최소. 확장·데몬이 같은 스키마 패키지를 공유한다.

## 요약

| 영역 | 선택 | 이유 | 검토 후 제외 |
| --- | --- | --- | --- |
| 런타임 | **Node.js 24 LTS** (Krypton, v24.22.2) | 2028-04까지 지원되는 LTS. `.ts`를 타입만 지우고 바로 실행하므로 데몬에는 빌드 단계가 없음. 내장 `node:sqlite`, `fetch`. 26 LTS(Lithium)도 나와 있으며 의존성 확인 후 올릴 수 있음 | Node 20 (2026-04 EOL), Bun (Agent SDK·Claude Code 생태계와 맞추기 위해 Node 유지) |
| 언어 | **TypeScript 7 (네이티브 컴파일러), ESM** | 확장·데몬·스키마를 한 언어로. 타입 검사만 하고(`noEmit`), `erasableSyntaxOnly`로 Node가 바로 실행할 수 있는 문법만 허용(enum·namespace·매개변수 프로퍼티 금지) | — |
| 모노레포 | **pnpm 12 workspaces** (corepack으로 버전 고정) | 디스크 효율, 워크스페이스 프로토콜 | npm workspaces, Turborepo (규모 대비 과함) |
| 데몬 HTTP | **Hono + @hono/node-server** | 작고 TS 친화적, SSE 헬퍼, zod 검증 미들웨어 | Fastify (더 무거움), `node:http` 직접 (Bridge 방식이지만 라우팅·SSE·검증 보일러플레이트 증가) |
| 계약·검증 | **zod 4** (`packages/protocol`) | 런타임 검증과 타입을 함께 제공. `z.toJSONSchema(schema, { target: "draft-7" })`로 LLM 출력 스키마도 생성 (Agent SDK는 draft-07 검증) | io-ts, TypeBox |
| 저장소 | **node:sqlite** (내장) | WSL에서 네이티브 빌드 없음 | better-sqlite3 (성능은 좋지만 네이티브 애드온), 파일 JSON |
| 프로세스 실행 | **`node:child_process` `execFile`** (셸 없이 인자 배열) | `tmux`, `claude agents --json`, `ss`, `git` 호출. 셸 인젝션 차단 | execa (편의 대비 의존성) |
| 코드 검색 | **@vscode/ripgrep** | `rg` 바이너리를 npm으로 제공. 이 머신 PATH에는 `rg`가 없음 | 직접 파일 순회 (느림) |
| 어휘 랭킹 | **직접 만든 토큰 겹침 점수** (한글 조사 대비 앞부분 일치) | 세션이 10개 안팎이라 색인이 필요 없음. MiniSearch는 세션이 많아지면 도입 | 임베딩 모델 (과함, 로컬 GPU 의존 발생) |
| LLM 재순위 | **@anthropic-ai/claude-agent-sdk** `query()` + `outputFormat: { type: "json_schema" }` | 로그인된 Claude Code 구독 인증 재사용(Cadence에서 검증), API 키 불필요, 검증된 JSON 반환 | `@anthropic-ai/sdk` 직접 호출 (API 키 필요, `Reranker` 인터페이스로 교체 가능하게 둠) |
| 기본 모델 | `claude-opus-5-5` (effort `low`), 대안 `claude-haiku-5-5` | 분류형 작업은 low effort로 충분. 지연이 문제면 Haiku | — |
| 확장 프레임워크 | **WXT** (MV3, Vite 기반) | 브라우저별 빌드(Edge 기본, Chrome, Firefox), 엔트리포인트 파일 규칙, side panel 지원, `world: "MAIN"` content script, `createShadowRootUi`, HMR | Plasmo (유지보수 둔화), 순수 Vite + crxjs |
| 확장 UI | **React 19** | 작성 팝업·상태 칩·사이드 패널이 컴포넌트(세션 목록, 상태 표시)를 공유. content script는 격리된 world에서 돌아 페이지의 React와 충돌하지 않음. 단축키를 누를 때만 주입 | Preact (작지만 공유 이점은 같음, 크기가 문제되면 교체), Svelte |
| 선택 오버레이 | **바닐라 TS** | 마우스가 움직일 때마다 도는 부분이라 프레임 단위(rAF)로 직접 그림 | React로 호버 처리 (렌더링 비용) |
| 페이지 위 UI 격리 | **Shadow DOM + HTML `popover`(top layer)** | 페이지 CSS·z-index와 상관없이 항상 위에 뜨고 레이아웃을 바꾸지 않음 | 높은 z-index (페이지와 경쟁), 사이드바 (페이지 폭이 줄어 반응형 레이아웃이 바뀜) |
| 팝업 위치 | **@floating-ui/dom** | 선택 영역 옆에 배치하고, 화면 밖이면 뒤집거나 안쪽으로 밀어 넣음 | 직접 계산 |
| React fiber 접근 | **bippy** | React 19의 `_debugStack`/owner stack 처리, 버전별 내부 구조 차이 흡수 | 직접 `__reactFiber$` 파싱 |
| 소스맵 복원 | **source-map-js** | owner stack의 번들 위치를 원본 `file:line`으로 | `source-map` (WASM 초기화 필요) |
| 스크린샷 | `chrome.tabs.captureVisibleTab` + OffscreenCanvas 자르기 | 실제 렌더링 그대로. 호출 제한 초당 2회 → 캡처당 1회만 | html2canvas / modern-screenshot (재렌더링이라 실제 화면과 다를 수 있음) |
| 스타일 | 일반 CSS + `:root` 토큰 | 패널이 작음 | Tailwind |
| 테스트 | **Vitest 5** (단위, happy-dom), **Playwright 1.64** (E2E: headless Chromium에 `WXT_E2E=1` 빌드 로드 + 시험 페이지 + 임시 데몬) | 토큰을 쓰지 않는 E2E. e2e 빌드만 모든 사이트 권한·테스트 훅·열린 shadow root를 가짐 | node:test (DOM 테스트에 부적합) |
| 서비스 실행 | `switchboard start`(백그라운드) / 선택: systemd user unit | WSL systemd 사용 가능 시 자동 시작 | pm2 |

## 외부 인터페이스 의존도

| 인터페이스 | 공식 여부 | 쓰는 곳 | 깨질 때 |
| --- | --- | --- | --- |
| `claude agents --json` | 공식 | Session Registry (소스 오브 트루스) | 레지스트리 파일 폴백 |
| Claude Code HTTP 훅 | 공식 | Activity Tracker, 전달 검증 | transcript tail 폴백 |
| tmux (`list-panes`, `load-buffer`, `paste-buffer -p`, `send-keys`, `capture-pane`) | 안정 CLI | Dispatcher | 전달 불가, 사용자에게 수동 안내 |
| `~/.claude/sessions/<pid>.json` | 내부 | 변경 감지 힌트, tmux 폴백 | 15초 정합성 갱신으로만 동작 |
| transcript JSONL | 내부 ("버전마다 바뀜"이라고 공식 문서가 명시) | 제목·최근 프롬프트·파일 | 훅이 없으면 추천 정확도 하락 |
| `ss -ltnp`, `/proc` | Linux 표준 | 포트 소유자, pid 계보 | S2 신호 비활성 |

## 버전 고정 방침

- `engines.node >= 24`, `.nvmrc` = 24, `packageManager: pnpm@12.16.1`
- 실제 설치 버전: TypeScript 7.0.2, Vitest 5.0.5, zod 4.6.7, @types/node 24.19.2
- Claude Code 최소 버전: `claude agents --json`의 `status`/`waitingFor`가 있는 버전. 이 머신은 v2.1.316. `switchboard doctor`가 확인한다.
- tmux ≥ 3.2 (`paste-buffer -p`). 이 머신은 3.4.
