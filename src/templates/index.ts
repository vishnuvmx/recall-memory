export const AGENT_BLOCK = `## Recall Project Memory & Anti-Scan Protocol

This project uses Recall: Markdown project memory in \`.recall/\`.

### CRITICAL: User Request Always Has Priority #1
- The user's CURRENT prompt is ALWAYS your primary objective.
- For operational commands (e.g. builds, tests, git commands, queries, single-file edits): EXECUTE THEM DIRECTLY. Do NOT read memory files, search tokens, or explore unrelated code.
- NEVER execute previous "next steps" from \`CURRENT_STATE.md\` unless the user explicitly tells you to "continue", "resume", or work on that specific topic.

### When to Consult Memory (Complex / Multi-File Tasks Only)
1. Read \`.recall/PROJECT_MAP.md\` ONLY when you need to locate files, entry points, or large file line landmarks without crawling directories (if missing, run \`recall map\` once to generate it).
2. For architectural decisions or domain gotchas: Run \`recall context "<task>"\` to retrieve relevant records.
3. \`.recall/CURRENT_STATE.md\` is historical context ("what was touched in the last session"). It is NOT a pending to-do list.

### Recording Learnings & Proposing Memory
If you discovered an important architecture invariant or fixed a tricky bug:
1. Run \`recall propose "<learning or decision text>" -t "<title>" --type <decision|lesson|convention>\`.
2. Do NOT attempt to mark memories active directly; proposed memories require human review (\`recall approve\`).
3. Never store credentials, API keys, private keys, or secrets in memory.

### End of Session / AI Chat Checkpoint
At the end of EVERY AI chat or task session:
1. Run \`recall checkpoint "<1-sentence summary of what YOU just did>"\` (or call MCP \`recall_checkpoint\`).
2. Do NOT add \`--next\` unless the user explicitly requested a multi-step plan that remains half-done.
3. This maintains a rolling 14-day history in \`.recall/sessions/session-log.md\` (older entries beyond 14 days are automatically pruned as things grow).`;

export const MEMORY_MD = `# Project Memory

Short overview of this project. Edit this file by hand; Recall never overwrites it.

## Critical constraints

- (Add the few rules that must never be broken.)

## Where to look

Detailed knowledge is indexed in [INDEX.md](INDEX.md). Search it with \`recall context "<task>"\`.
`;

export const RULE_TEMPLATES: Record<string, string> = {
  'architecture.md': '# Architecture rules\n\nDescribe the architecture constraints agents must preserve.\n',
  'coding-style.md': '# Coding style\n\nDescribe naming, formatting, and structure conventions.\n',
  'design-system.md': '# Design system\n\nList design tokens/components and the checks that enforce them.\n',
  'workflows.md': '# Workflows\n\nDescribe build, test, and release commands agents should use.\n',
};

export const CHANGELOG_MD = '# Recall changelog\n\nLocal log of memory operations. Git history is authoritative when available.\n\n';

export const ANTIGRAVITY_RULE = `---
trigger: always_on
---

# Recall Invariants & Protocol

1. User Request Priority: The user's prompt is ALWAYS primary objective #1.
2. Direct Execution: For routine commands, builds, tests, or single-file edits, EXECUTE THEM DIRECTLY without reading memory files.
3. Complex Architecture Tasks: Locate landmark lines via \`.recall/PROJECT_MAP.md\` or run \`recall context "<task>"\`.
4. Wrap Up: At the end of every AI chat / session, run \`recall checkpoint "<1-sentence summary>"\` (maintains rolling 14-day history).
5. Learnings: Save discoveries via \`recall propose "<text>" -t "<title>"\` (never direct active writes).
`;

export const ANTIGRAVITY_SKILL = `---
name: recall
description: Project memory, codebase topology, and orientation protocol for multi-file tasks. Activate when navigating large files, querying architectural decisions, or checkpointing sessions.
---

# Recall Agent Protocol

This project uses Recall for persistent Git-versioned memory in \`.recall/\`.

## Orientation
1. Do NOT crawl directories recursively. Read \`.recall/PROJECT_MAP.md\` to find entry points, theme tokens, and symbol landmarks.
2. In files $\\ge 300$ lines, use landmark lines as anchors ($\\pm 50$ line window) to view target code directly.
3. For architectural constraints: run \`recall context "<task>"\` or call MCP \`recall_context\`.

## Recording State
1. Propose decisions/lessons: \`recall propose "<text>" -t "<title>" --type <decision|lesson|convention>\`.
2. Wrap-up checkpoint: \`recall checkpoint "<summary>"\` at the end of every AI chat session (maintains rolling 14-day history).
`;
