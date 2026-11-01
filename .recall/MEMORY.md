# Project Memory

Short overview of this project. Edit this file by hand; Recall never overwrites it.

## Critical constraints

- Local-first execution: Zero runtime network calls, zero telemetry, zero cloud vector stores.
- Non-volatile warm orientation: `.recall/PASSPORT.md` holds hash-fingerprinted stack, commands, module exports, and active rules so AI models never cold-scan the repository.
- Prompt-cache discipline: Always-on instructions (`AGENTS.md`) remain static and strictly under 120 tokens.
- Read-only Git ops: Never commit, push, or stage workspace code automatically.

## Where to look

Detailed knowledge is indexed in [INDEX.md](INDEX.md). Search it with `recall context "<task>"`.
