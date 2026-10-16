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
> **Last Updated**: 2026-10-16 13:03:00
## Previous Progress
Added adaptive model tiers (compact, standard, frontier), full codebase API surface extraction, and MTime digest cache
## Files Modified in Previous Task
- `src/cli/index.ts`
- `src/core/config.ts`
- `src/core/init.ts`
- `src/core/landmarks.ts`
- `src/core/mapper.ts`
- _(+3 other files)_

## Protocol
1. User Request Priority: The user's prompt is ALWAYS primary objective #1.
2. Direct Execution: You ALREADY have the warm state above; execute requests directly with full awareness of recent changes.
3. Complex Architecture Tasks: Locate landmark lines via `.recall/PROJECT_MAP.md` or run `recall context "<task>"`.
4. Wrap Up: Run `recall checkpoint "<1-sentence summary>"` before completing responses that modified code across files.
5. Learnings: Save discoveries via `recall propose "<text>" -t "<title>"` (never direct active writes).
<!-- recall:end -->
