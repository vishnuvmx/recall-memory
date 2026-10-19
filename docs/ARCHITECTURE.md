# Recall Architecture & Technical Specification

Recall provides zero-maintenance, cache-stable project memory and codebase topology for AI coding agents. This document details its architectural invariants, orientation protocol, team Git strategy, and retrieval mechanics.

---

## 1. Architectural Invariants

1. **Zero Runtime Network Calls**: Recall never calls external APIs, never transmits code to a cloud database, and adds no third-party telemetry.
2. **Plain Markdown as Source of Truth**: All knowledge is stored in standard Markdown files with validated YAML frontmatter. Everything is human-editable and reviewable via `git diff`.
3. **Read-Only Git Operations**: Recall queries Git for log history and uncommitted diffs using `--no-optional-locks` to avoid touching index locks. Recall never commits, pushes, or stages repository changes automatically.
4. **Prompt Budget Discipline**: Always-on agent instructions stay strictly under **120 tokens** and remain 100% static across sessions to preserve LLM prompt caching. Targeted retrieval (`recall where` and `recall context`) is capped at ~400 tokens on demand.
5. **Zero-Maintenance Autonomy**: AI agents autonomously record decisions and gotchas directly (`writes: "auto"`), while near-duplicate detection updates records in place to prevent memory bloat.

---

## 2. System Architecture & The Agent Orientation Loop

```
       ┌────────────────────────────────────────────────────────┐
       │              Developer / AI Coding Agent               │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 1. Cold start: static instructions in AGENTS.md
                                 │    (≤ 115 tokens always-on, 100% cache-stable)
                                 │    Skip upfront reads for routine edits.
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │             Targeted On-Demand Navigation              │
       │  • Find symbol/file: `recall where <name>`             │
       │  • Unfamiliar area: `recall context "<topic>"`         │
       │  • Output strictly capped at ~400 tokens               │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 2. Task execution & learning:
                                 │    `recall remember "<rule>" -t "<title>"`
                                 │    (Near-duplicates updated in place)
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │                 Local Persistence Engine               │
       │  • Autonomous active write or review gate              │
       │  • Secret scanning rejects tokens/keys                 │
       │  • Silent session hook: `recall checkpoint --hook`     │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 3. Team Git review (optional):
                                 │    `git diff .recall/` (human PR control)
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │                  Git Repository Remote                 │
       │  • Shared: MEMORY.md, INDEX.md, rules/, decisions/     │
       │  • Gitignored: PROJECT_MAP.md, CURRENT_STATE.md        │
       └────────────────────────────────────────────────────────┘
```

---

## 3. Fresh Clones & CI Environments

In team setups where `PROJECT_MAP.md` and `CURRENT_STATE.md` are gitignored to prevent PR merge conflicts, a fresh clone or CI worker initially has neither file.

**How this is resolved:**
1. **Pull-Based Orientation**: The static managed block in `AGENTS.md` tells the agent:
   > *"Memory is in `.recall/`. Don't read it upfront; skip it for routine edits."*
   There is zero requirement to pre-generate or ingest large maps on startup.
2. **On-Demand Symbol Resolution**: When an agent needs to locate an unfamiliar symbol or file, it runs `recall where <name>` which builds or checks landmarks in under **50 ms**.
3. **CI / Hooks**: Checkpoints and map refreshes happen silently in the background via `recall checkpoint --hook` without manual intervention or LLM round-trips.

---

## 4. Line Landmark Drift Protocol & Targeted Locator (`recall where`)

Landmarks provide line numbers (e.g., `- **L420**: _exportPdf`) for symbols in files with $\ge 300$ lines.

* **Targeted Locator (`recall where <name>`)**: Instead of reading a 2,000-token project map upfront, agents look up specific functions, classes, types, or config files (e.g., `package.json`, `Dockerfile`) on demand. The response is a single concise line anchor.
* **Mid-Task Drift**: Landmark line numbers are fresh at the start of a task. When the agent edits lines earlier in the file, line numbers further down shift.
* **The Target Window Protocol**: Agents treat landmark lines as **rough target anchors ($\pm 50$ lines)**. If mid-turn edits shift lines, the agent searches for the symbol name within that 50-line window rather than re-reading the entire file.
* **Silent Hook Auto-Refresh**: Checkpoints run idempotently via `recall checkpoint --hook` on session close or Git hooks, updating landmarks without burning LLM turns.

---

## 5. Team Git Strategy: Shared vs. Ephemeral State

Committing line numbers on every commit will produce merge conflicts across concurrent feature branches. Recall solves this by partitioning state:

```
.recall/
  ├── config.json              <-- [SHARED] Project settings (writes: "auto" | "review")
  ├── MEMORY.md                <-- [SHARED] Architectural boundaries & negative rules
  ├── INDEX.md                 <-- [SHARED] Deterministic catalog of rules & decisions
  ├── rules/                   <-- [SHARED] Conventions, design tokens, domain facts
  ├── decisions/               <-- [SHARED] Architecture Decision Records (ADRs)
  ├── lessons/                 <-- [SHARED] Debugging gotchas & failed approaches
  │
  ├── PROJECT_MAP.md           <-- [EPHEMERAL - GITIGNORED] Regenerated locally in ~50 ms
  ├── CURRENT_STATE.md         <-- [EPHEMERAL - GITIGNORED] Developer's active branch task
  └── sessions/                <-- [EPHEMERAL - GITIGNORED] Local session checkpoint log
```

### Recommended Team `.recall/.gitignore`:
```gitignore
# Ephemeral local agent files (prevents PR merge conflicts across branches)
PROJECT_MAP.md
CURRENT_STATE.md
sessions/
```

With this policy, PRs contain only intentional architectural changes, never noisy line number shifts or colliding session notes.

---

## 6. Comprehensive Competitor Comparison

| Dimension | Plain `AGENTS.md` / `CLAUDE.md` | Aider Repo Map | Cursor Codebase Index | Claude Code Auto-Memory | Recall |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Mechanism** | Static Markdown instruction file | In-memory Tree-sitter AST + PageRank graph | Local/remote vector embeddings + Merkle sync | Unindexed markdown in `~/.claude/` | In-repo Git markdown + token landmark parser |
| **Memory Structure** | Monolithic text document | None (orientation only) | Opaque vector database | Flat text bullet points (soft-capped at 200 lines) | **Modular records** (`decisions/`, `lessons/`, `rules/`) |
| **Context Growth** | Monotonic bloat (entire file read every turn) | Recalculated dynamically per turn | Semantic vector chunks retrieved on demand | Soft-capped at 200 lines | **≤ 115 tok always-on (cache-stable); capped on-demand retrieval (~400 tok)** |
| **Team Sharing** | Shared in Git | Ephemeral | Cloud index locked to team workspace | Not shared (lives in user `$HOME` dir) | **Shared in Git** (`rules/`, `decisions/`, `MEMORY.md`) |
| **Code Review Control** | Fully reviewable | N/A | Inauditable (binary/cloud) | Unversioned | **Fully reviewable via `git diff`** |
| **Semantic Recall** | None | High for symbol references | High for fuzzy concepts/synonyms | None | **Keyword + stem** (explainable, misses unmapped synonyms) |
| **Indexing Cost** | Zero | CPU cost per turn | Token embedding API costs | Zero | **Zero API cost (< 120 ms local scan)** |

### What Recall Adds Over Plain `AGENTS.md`:
1. **Cache Stability**: Keeps always-on instructions static (~97 tokens in `AGENTS.md`, ~18 tokens in skills). Never invalidates LLM prompt caches on session checkpoints.
2. **On-Demand Targeted Navigation (`recall where`)**: Direct anchors to symbol definitions and manifest files instead of multi-step exploratory greps.
3. **Budget-Capped Retrieval (`recall context`)**: Caps search hits to ~400 tokens of high-signal excerpts, preventing prompt dilution.
4. **Autonomous In-Place Learning**: Agents write lessons and decisions directly (`writes: "auto"`). Near-duplicate detection rewrites records in place to prevent memory sprawl.
5. **Optional Review Governance**: Teams wanting strict review can configure `writes: "review"`, holding memory updates in `proposed` state until approved.

---

## 7. Retrieval Mechanics: Explainability vs. Vocabulary Mismatch

Recall uses tokenized keyword matching with suffix stemming (e.g., `stem("indexing")` $\to$ `"index"`). Matches are weighted by location:
* Exact title match: +15
* Title substring match: +8
* Title token match: +3 (stemmed: +2)
* Tag match: +2 (stemmed: +1.5)
* Section heading match: +2 (stemmed: +1.5)
* Body match: +1 per occurrence up to 3 (stemmed: +1)

### Compact Output Budget
Agent retrieval responses format hits into concise bulleted highlights (`formatHitsCompact()`), hard-capped at **~400 tokens**. Full markdown documents are read only when deeper historical context is explicitly requested.

### The Trade-off
* **Explainability**: Every result is predictable and debuggable. Run `recall context "<task>" --format json` to see the exact scoring breakdown.
* **Vocabulary Mismatch**: Keyword matching does not understand synonyms. If a document discusses *"OAuth token refresh"* without the word *"login"*, an agent querying *"login logic"* will receive 0 matches.

### Mitigation Strategies:
1. **Tags**: Memory authors and agents include common synonyms in frontmatter `tags: [auth, login, session, oauth]`.
2. **Fallback Protocol**: If `recall context` returns no matches, agents broaden query terms or fall back to targeted live file grepping.

---

## 8. Safe Revert Mechanism (`recall undo`)

`recall undo` safely discards uncommitted changes and removes untracked memory files created during an agent session.

```bash
# Preview what would be restored and deleted without modifying anything
recall undo --dry-run

# Execute safe discard
recall undo
```

**Safety Safeguards:**
* **Confined to `.recall/`**: Never touches workspace source code outside `.recall/`.
* **Gitignored Protection**: Files listed in `.gitignore` (such as local `CURRENT_STATE.md`) are never touched by `git clean`.
* **Index Coherence**: Automatically rebuilds `INDEX.md` after restoring tracked files.
