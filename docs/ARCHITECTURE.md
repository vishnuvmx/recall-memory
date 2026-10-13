# Recall Architecture & Technical Specification

Recall provides persistent, structured, Git-versioned project memory and codebase topology for AI coding agents. This document details its architectural invariants, orientation protocol, team Git strategy, and retrieval mechanics.

---

## 1. Architectural Invariants

1. **Zero Runtime Network Calls**: Recall never calls external APIs, never transmits code to a cloud database, and adds no third-party telemetry.
2. **Plain Markdown as Source of Truth**: All knowledge is stored in standard Markdown files with validated YAML frontmatter. Everything is human-editable and reviewable via `git diff`.
3. **Read-Only Git Operations**: Recall queries Git for log history and uncommitted diffs using `--no-optional-locks` to avoid touching index locks. Recall never commits, pushes, or stages repository changes automatically.
4. **Prompt Budget Discipline**: Orientation maps are enforced with priority truncation to guarantee prompt footprints remain under **1,500 tokens** regardless of repository size.

---

## 2. System Architecture & The Agent Orientation Loop

```
       ┌────────────────────────────────────────────────────────┐
       │              Developer / AI Coding Agent               │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 1. Cold start: reads .recall/MEMORY.md
                                 │    and .recall/PROJECT_MAP.md (< 1,500 tok)
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │            Orientation & Targeted Execution            │
       │  • Jumps directly to landmark lines (±50 line window)   │
       │  • Falls back to live grep/glob for deep subtree files │
       │  • Executes code modifications                         │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 2. Task completion:
                                 │    runs `recall checkpoint "summary"`
                                 ▼
       ┌────────────────────────────────────────────────────────┐
       │                 Local Persistence Engine               │
       │  • Records Git-modified files to CURRENT_STATE.md       │
       │  • Appends summary to sessions/session-log.md          │
       │  • Auto-refreshes PROJECT_MAP.md landmarks (< 120 ms)  │
       └─────────────────────────┬──────────────────────────────┘
                                 │ 3. Team Git review:
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
1. **The Anti-Scan Protocol**: The managed block in `AGENTS.md` (or `CLAUDE.md`) instructs the agent:
   > *"If `.recall/PROJECT_MAP.md` does not exist, run `recall map` once to generate it."*
2. **Deterministic Speed**: `recall map` completes in **~30 ms** on small repos and **~100 ms** on 80k-LOC codebases.
3. **CI / Hooks (Optional)**: Teams can add `npx recall map` to a `post-checkout` Git hook or initial `npm install` script.

---

## 4. Line Landmark Drift Protocol

Landmarks provide line numbers (e.g., `- **L420**: _exportPdf`) for symbols in files with $\ge 300$ lines.

* **Mid-Task Drift**: Landmark line numbers are fresh at the start of a task. When the agent edits lines earlier in the file, line numbers further down shift.
* **The Target Window Protocol**: Agents are instructed to treat landmark lines as **rough target anchors ($\pm 50$ lines)**. If mid-turn edits have shifted lines, the agent searches for the symbol name within that 50-line window rather than reading the entire file.
* **Session Close Auto-Refresh**: When the agent finishes and runs `recall checkpoint "summary"`, Recall recalculates landmarks and updates `PROJECT_MAP.md` automatically for the next session.

---

## 5. Team Git Strategy: Shared vs. Ephemeral State

Committing line numbers on every commit will produce merge conflicts across concurrent feature branches. Recall solves this by partitioning state:

```
.recall/
  ├── config.json              <-- [SHARED] Project settings
  ├── MEMORY.md                <-- [SHARED] Architectural boundaries & negative rules
  ├── INDEX.md                 <-- [SHARED] Deterministic catalog of rules & decisions
  ├── rules/                   <-- [SHARED] Conventions, design tokens, domain facts
  ├── decisions/               <-- [SHARED] Architecture Decision Records (ADRs)
  ├── lessons/                 <-- [SHARED] Debugging gotchas & failed approaches
  │
  ├── PROJECT_MAP.md           <-- [EPHEMERAL - GITIGNORED] Regenerated locally in ~100 ms
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
| **Context Growth** | Monotonic bloat (entire file read every turn) | Recalculated dynamically per turn | Semantic vector chunks retrieved on demand | Soft-capped at 200 lines | **Fixed-size root + on-demand retrieval** |
| **Team Sharing** | Shared in Git | Ephemeral | Cloud index locked to team workspace | Not shared (lives in user `$HOME` dir) | **Shared in Git** (`rules/`, `decisions/`, `MEMORY.md`) |
| **Code Review Control** | Fully reviewable | N/A | Inauditable (binary/cloud) | Unversioned | **Fully reviewable via `git diff`** |
| **Semantic Recall** | None | High for symbol references | High for fuzzy concepts/synonyms | None | **Keyword + stem** (explainable, misses unmapped synonyms) |
| **Indexing Cost** | Zero | CPU cost per turn | Token embedding API costs | Zero | **Zero API cost (< 120 ms local scan)** |

### What Recall Adds Over Plain `AGENTS.md`:
1. **Modular Knowledge**: Separates persistent architectural boundaries from transient task notes.
2. **Deterministic Retrieval (`recall context`)**: Prevents bloating the system prompt by pulling only relevant decisions.
3. **Repository Topology & Landmarks (`PROJECT_MAP.md`)**: Gives the agent entry points, design tokens, and symbol line numbers to prevent exploratory directory scans.
4. **Lifecycle Governance**: Tracks memories through `proposed`, `active`, `superseded`, and `archived` states.
5. **Proposal Gate**: Agent-suggested rules land as `proposed` and cannot influence retrieval until approved by a human.

---

## 7. Retrieval Mechanics: Explainability vs. Vocabulary Mismatch

Recall uses tokenized keyword matching with suffix stemming (e.g., `stem("indexing")` $\to$ `"index"`). Matches are weighted by location:
* Exact title match: +15
* Title substring match: +8
* Title token match: +3 (stemmed: +2)
* Tag match: +2 (stemmed: +1.5)
* Section heading match: +2 (stemmed: +1.5)
* Body match: +1 per occurrence up to 3 (stemmed: +1)

### The Trade-off
* **Explainability**: Every result is predictable and debuggable. Run `recall context "<task>" --format json` to see the exact scoring breakdown.
* **Vocabulary Mismatch**: Keyword matching does not understand synonyms. If a document discusses *"OAuth token refresh"* without the word *"login"*, an agent querying *"login logic"* will receive 0 matches.

### Mitigation Strategies:
1. **Tags**: Memory authors and agents should include common synonyms in frontmatter `tags: [auth, login, session, oauth]`.
2. **Fallback Protocol**: If `recall context` returns no matches, agents are instructed to broaden query terms or fall back to targeted live file grepping.

---

## 8. Safe Revert Mechanism (`recall undo`)

`recall undo` safely discards uncommitted changes and removes untracked memory files created during an agent session.

```bash
# Preview what would be restored and deleted without modifying anything
recall undo --dry-run

# Execute safe discard
recall undo
```

**Safety Guarantees:**
* **Confined to `.recall/`**: Never touches workspace source code outside `.recall/`.
* **Gitignored Protection**: Files listed in `.gitignore` (such as local `CURRENT_STATE.md`) are never touched by `git clean`.
* **Index Coherence**: Automatically rebuilds `INDEX.md` after restoring tracked files.
