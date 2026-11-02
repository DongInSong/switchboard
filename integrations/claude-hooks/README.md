# @switchboard/claude-hooks (planned)

Not implemented yet. An optional Claude Code plugin that would post session events to the daemon over HTTP hooks, as a faster signal than reading transcripts:

| Event | Use |
| --- | --- |
| `SessionStart` / `SessionEnd` | register and clean up sessions |
| `UserPromptSubmit` | recent prompts, delivery marker check |
| `PostToolUse` (Edit\|Write\|MultiEdit) | recently edited files |
| `Stop` | `last_assistant_message` as the completion summary |
| `Notification` (permission_prompt\|idle_prompt) | waiting state |

Switchboard works without it.
