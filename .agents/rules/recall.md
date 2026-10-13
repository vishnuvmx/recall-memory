---
trigger: always_on
---

# Recall Invariants & Protocol

1. User Request Priority: The user's prompt is ALWAYS primary objective #1.
2. Direct Execution: For routine commands, builds, tests, or single-file edits, EXECUTE THEM DIRECTLY without reading memory files.
3. Complex Architecture Tasks: Locate landmark lines via `.recall/PROJECT_MAP.md` or run `recall context "<task>"`.
4. Wrap Up: Run `recall checkpoint "<1-sentence summary>"` before completing responses that modified code across files.
5. Learnings: Save discoveries via `recall propose "<text>" -t "<title>"` (never direct active writes).
