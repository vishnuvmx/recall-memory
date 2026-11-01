---
name: recall
description: Project memory lookups (context, where) and recording learnings.
---

<!-- recall:begin -->
# Recall

Project memory lives in `.recall/` as plain Markdown + local SQLite FTS5/vector cache. Use it so you never cold-scan the repository or forget architectural decisions across models and sessions.

## Look things up (zero cold-run analysis)
- **New chat / unfamiliar repo**: read `.recall/PASSPORT.md` once (~400 tokens). It holds the non-volatile tech stack, verified commands, module exports, and active invariants.
- **Specific topic / bug history**: `recall context "<topic>"` (hybrid BM25 + dense vector search, capped at ~400 tokens).
- **Exact symbol or file location**: `recall where <symbol-or-path>` (live MTime-cached `file:line` jump targets).
- **Continuing unfinished work**: read `.recall/CURRENT_STATE.md` (history of the previous chat/session, not an automatic to-do list).

## Record non-volatile knowledge for all AI models
- `recall remember "<text>" -t "<title>" --type <decision|convention|lesson|bugfix|failed_approach>`
- Save durable truths: architectural decisions, non-obvious invariants, root causes, and rejected dead ends.
- Similar titles update existing memories in place and automatically refresh `.recall/PASSPORT.md`.
- Never store secrets or credentials (automatically rejected).

## Don't
- Don't crawl directories or cold-read 15+ files when `.recall/PASSPORT.md` and `recall where` already map the codebase.
- Don't manually checkpoint at turn end; lifecycle hooks (`recall checkpoint --hook`) capture chats and sync incrementally.
<!-- recall:end -->
