# @switchboard/protocol

확장과 데몬이 공유하는 zod 스키마. `Capture`, `ElementInfo`, `SourceHint`, `Session`, `Request`, `Recommendation`, `Dispatch`, SSE 이벤트.
LLM 재순위 출력 스키마도 여기서 `z.toJSONSchema(..., { target: "draft-7" })`로 만든다.

초안 타입: [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.1, §5.3
