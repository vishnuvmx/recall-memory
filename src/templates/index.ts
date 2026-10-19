/**
 * Always-on instruction installed into the agent file (AGENTS.md by default).
 *
 * TOKEN BUDGET: this text is injected into EVERY agent turn, so it is capped at
 * ~120 tokens. It must also be STATIC
 * (never embed dynamic state): changing always-on text invalidates provider
 * prompt caches and silently multiplies cost. Detail belongs in the on-demand
 * skill (ANTIGRAVITY_SKILL_BODY), not here.
 */
export const AGENT_BLOCK = `## Project memory (Recall)
Memory is in \`.recall/\`. Don't read it upfront; skip it for routine edits.
- Unfamiliar area or design question: \`recall context "<topic>"\`
- Find a symbol or file: \`recall where <name>\`
- Learned a non-obvious rule or bug cause: \`recall remember "<text>" -t "<title>" --type <decision|convention|lesson>\`
Sessions are logged automatically; no wrap-up needed.`;

/** Kept so `recall init` can recognize and migrate files written by older versions. */
export const LEGACY_SKILL_MARKER = '# Recall Agent Protocol';

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

/**
 * On-demand skill: only its name + description are always visible to the agent;
 * the body is loaded when the agent decides it is relevant. Detail lives here.
 */
export const SKILL_FRONTMATTER = `---
name: recall
description: Project memory lookups (context, where) and recording learnings.
---`;

export const ANTIGRAVITY_SKILL_BODY = `# Recall

Project memory lives in \`.recall/\` as Markdown. Use it to avoid re-discovering things, not as a ritual.

## Look things up (pull, never push)
- \`recall context "<topic>"\`: past decisions, conventions, and lessons. Output is capped (~400 tokens). Verify claims against current code.
- \`recall where <symbol-or-path>\`: \`file:line\` locations from a cached symbol scan. Open only the lines you need.
- Continuing earlier work: read \`.recall/CURRENT_STATE.md\`. It is history, not a to-do list.

## Record what future sessions need
- \`recall remember "<text>" -t "<title>" --type <decision|convention|lesson|bugfix|failed_approach>\`
- Record only non-obvious knowledge: why a design was chosen, invariants, root causes, dead ends.
- Re-recording a similar title updates the existing memory instead of duplicating it.
- Never store secrets (writes containing them are rejected).

## Don't
- Don't read \`.recall/\` files wholesale or "orient" before simple tasks.
- Don't run a checkpoint at the end of a session; a hook records it automatically.`;
