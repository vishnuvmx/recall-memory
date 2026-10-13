# Project Memory

Short overview of this project. Edit this file by hand; Recall never overwrites it.

## Critical constraints

- Local-first execution: No external network calls, no telemetry, no cloud vector stores.
- Human review gate: All agent proposals must land as `proposed` until reviewed and approved.
- Read-only Git ops: Never commit, push, or stage workspace code automatically.

## Where to look

Detailed knowledge is indexed in [INDEX.md](INDEX.md). Search it with `recall context "<task>"`.
