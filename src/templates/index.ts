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
Memory is in \`.recall/\`. Skip for trivial edits.
- New chat: read \`.recall/PASSPORT.md\` first (non-volatile blueprint; never cold-scan repo).
- Past decisions/bugs: \`recall context "<topic>"\`
- Locate symbol/file: \`recall where <name>\`
- Save rule/fix: \`recall remember "<text>" -t "<title>" --type <decision|convention|lesson|bugfix>\`
Chats sync locally via hooks.`;

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

Project memory lives in \`.recall/\` as plain Markdown + local SQLite FTS5/vector cache. Use it so you never cold-scan the repository or forget architectural decisions across models and sessions.

## Look things up (zero cold-run analysis)
- **New chat / unfamiliar repo**: read \`.recall/PASSPORT.md\` once (~400 tokens). It holds the non-volatile tech stack, verified commands, module exports, and active invariants.
- **Specific topic / bug history**: \`recall context "<topic>"\` (hybrid BM25 + dense vector search, capped at ~400 tokens).
- **Exact symbol or file location**: \`recall where <symbol-or-path>\` (live MTime-cached \`file:line\` jump targets).
- **Continuing unfinished work**: read \`.recall/CURRENT_STATE.md\` (history of the previous chat/session, not an automatic to-do list).

## Record non-volatile knowledge for all AI models
- \`recall remember "<text>" -t "<title>" --type <decision|convention|lesson|bugfix|failed_approach>\`
- Save durable truths: architectural decisions, non-obvious invariants, root causes, and rejected dead ends.
- Similar titles update existing memories in place and automatically refresh \`.recall/PASSPORT.md\`.
- Never store secrets or credentials (automatically rejected).

## Don't
- Don't crawl directories or cold-read 15+ files when \`.recall/PASSPORT.md\` and \`recall where\` already map the codebase.
- Don't manually checkpoint at turn end; lifecycle hooks (\`recall checkpoint --hook\`) capture chats and sync incrementally.`;
