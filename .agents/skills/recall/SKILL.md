---
name: recall
description: Project memory lookups (context, where) and recording learnings.
---

<!-- recall:begin -->
# Recall

Project memory lives in `.recall/` as Markdown. Use it to avoid re-discovering things, not as a ritual.

## Look things up (pull, never push)
- `recall context "<topic>"`: past decisions, conventions, and lessons. Output is capped (~400 tokens). Verify claims against current code.
- `recall where <symbol-or-path>`: `file:line` locations from a cached symbol scan. Open only the lines you need.
- Continuing earlier work: read `.recall/CURRENT_STATE.md`. It is history, not a to-do list.

## Record what future sessions need
- `recall remember "<text>" -t "<title>" --type <decision|convention|lesson|bugfix|failed_approach>`
- Record only non-obvious knowledge: why a design was chosen, invariants, root causes, dead ends.
- Re-recording a similar title updates the existing memory instead of duplicating it.
- Never store secrets (writes containing them are rejected).

## Don't
- Don't read `.recall/` files wholesale or "orient" before simple tasks.
- Don't run a checkpoint at the end of a session; a hook records it automatically.
<!-- recall:end -->
