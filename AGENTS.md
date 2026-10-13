# Agent Guidelines

<!-- recall:begin -->
## Recall Project Memory & Anti-Scan Protocol

This project uses Recall: Markdown project memory in `.recall/`.

### CRITICAL: User Request Always Has Priority #1
- The user's CURRENT prompt is ALWAYS your primary objective.
- For operational commands (e.g. builds, tests, git commands, queries, single-file edits): EXECUTE THEM DIRECTLY. Do NOT read memory files, search tokens, or explore unrelated code.
- NEVER execute previous "next steps" from `CURRENT_STATE.md` unless the user explicitly tells you to "continue", "resume", or work on that specific topic.

### When to Consult Memory (Complex / Multi-File Tasks Only)
1. Read `.recall/PROJECT_MAP.md` ONLY when you need to locate files, entry points, or large file line landmarks without crawling directories (if missing, run `recall map` once to generate it).
2. For architectural decisions or domain gotchas: Run `recall context "<task>"` to retrieve relevant records.
3. `.recall/CURRENT_STATE.md` is historical context ("what was touched in the last session"). It is NOT a pending to-do list.

### Recording Learnings & Proposing Memory
If you discovered an important architecture invariant or fixed a tricky bug:
1. Run `recall propose "<learning or decision text>" -t "<title>" --type <decision|lesson|convention>`.
2. Do NOT attempt to mark memories active directly; proposed memories require human review (`recall approve`).
3. Never store credentials, API keys, private keys, or secrets in memory.

### End of Significant Tasks
Before completing responses that modified code across files:
1. Run `recall checkpoint "<1-sentence summary of what YOU just did>"`.
2. Do NOT add `--next` unless the user explicitly requested a multi-step plan that remains half-done.
<!-- recall:end -->
