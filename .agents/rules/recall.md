---
trigger: always_on
---

<!-- recall:begin -->
# Recall Invariants & Warm Memory Context

## Active Constraints
- Local-first execution: No external network calls, no telemetry, no cloud vector stores.
- Human review gate: All agent proposals must land as `proposed` until reviewed and approved.
- Read-only Git ops: Never commit, push, or stage workspace code automatically.

## Current Working State
> **Last Updated**: 2026-10-17 02:04:40
## Previous Progress
Implemented 14-day rolling window session retention, pruning of old entries, and auto-checkpoint mechanism for AI chats
## Files Modified in Previous Task
- `README.md`
- `src/cli/index.ts`
- `src/core/agent.ts`
- `src/core/checkpoint.ts`
- `src/core/config.ts`
- _(+6 other files)_

## Protocol
1. User Request Priority: The user's prompt is ALWAYS primary objective #1.
2. Direct Execution: You ALREADY have the warm state above; execute requests directly with full awareness of recent changes.
3. Complex Architecture Tasks: Locate landmark lines via `.recall/PROJECT_MAP.md` or run `recall context "<task>"`.
4. Wrap Up: At the end of every AI chat / session, run `recall checkpoint "<1-sentence summary>"` (maintains rolling 14-day history).
5. Learnings: Save discoveries via `recall propose "<text>" -t "<title>"` (never direct active writes).
<!-- recall:end -->
