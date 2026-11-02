# @switchboard/daemon

`switchboardd` 데몬과 `switchboard` CLI. 127.0.0.1:7490에서 확장의 요청을 받는다.

| 모듈 | 역할 |
| --- | --- |
| `api/` | Hono REST + SSE, 페어링 토큰·Origin·Host 검증 |
| `registry/` | `claude agents --json` + tmux pane 연결 + 생존 판별 — **구현됨 (P0)** |
| `activity/` | transcript tail (내부 포맷 격리) + HTTP 훅 수신 |
| `profiler/` | git·package.json·포트 소유자 맵 |
| `source/` | 경로 정규화·검증, ripgrep 폴백 |
| `recommend/` | 신호 점수 → (필요 시) LLM 재순위 |
| `compose/` | `context.md`·스크린샷 저장, 붙여넣을 프롬프트 생성 |
| `dispatch/` | 사전 점검 → tmux 붙여넣기 → 전달 검증, 세션별 대기열 |
| `store/` | node:sqlite |
| `cli/` | start, stop, status, pair, sessions, doctor, hooks — `sessions`, `doctor` **구현됨 (P0)** |

설계: [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.3–5.9
