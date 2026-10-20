<div align="center">

<p align="center">
  <img src="recall.png" alt="Recall Logo" width="100" />
</p>

# Recall: Zero-Maintenance Project Memory for AI Coding Agents

**Local-first, zero-maintenance project memory for AI coding agents.**

Markdown-based decisions, conventions, and codebase topology — retrieved on demand.  
Init once — your AI agent does the reading, learning, and checkpointing.

<!-- Badges -->

[![Status: Alpha](https://img.shields.io/badge/status-alpha%20(v0.1.0)-orange.svg)](#-about)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Local only](https://img.shields.io/badge/network-zero%20calls-success)](docs/SECURITY.md)
[![Storage](https://img.shields.io/badge/storage-local%20markdown-orange)](docs/ARCHITECTURE.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#-contributing)

<br />

[Quick Start](#-quick-start) •
[Commands](#-commands-reference) •
[Agent Compatibility](#-agent-compatibility) •
[Docs](#-documentation) •
[Contributing](#-contributing)

</div>

---

## 📖 Table of Contents

- [About](#-about)
- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Directory Structure](#-directory-structure)
- [Commands Reference](#-commands-reference)
- [Agent Compatibility](#-agent-compatibility)
- [How Retrieval Works Without Embeddings](#-how-retrieval-works-without-embeddings)
- [Supported Landmark Languages](#-supported-landmark-languages)
- [Token Budgets](#-token-budgets--priority-truncation)
- [Known Limitations & Trade-offs](#-known-limitations--trade-offs)
- [Why Not Just Use X?](#-why-not-just-use-x)
- [Development](#-development)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [Security](#-security)
- [License](#-license)

---

## 🎯 About

> [!NOTE]
> **Status: Alpha (v0.1.0)**. Recall gives AI coding agents persistent project memory in plain Markdown inside `.recall/`.

AI coding agents forget decisions between sessions and repeatedly re-scan entire repositories. Recall gives them structured memory and codebase topology with complete automation and zero prompt bloat.

- **Automated AI-First Workflow:** Don't do manual memory management. Let your AI agents do the heavy lifting—running commands, fetching context on demand, locating symbol landmarks, analyzing codebase invariants, and recording non-obvious bugfixes autonomously.
- **Cache-stable & token-disciplined:** Always-on prompt footprint is under **~120 tokens** and byte-stable across sessions (preserving provider prompt caching). No prompt mutation, no mandatory turn-ending tool calls.
- **Zero MCP Schema Bloat:** Operates via native CLI commands (`recall context`, `recall where`, `recall remember`) and agent rules/skills. Removing MCP eliminates 180+ tokens of tool schemas on *every single turn*.
- **Context-Optimized for Big Projects:** Automatically excludes test directories and test files from the project map and landmark indexing, ensuring **80–90%+ of the token budget is dedicated directly to production application architecture**.
- **No network calls, zero-cloud storage:** Plain Markdown in `.recall/`, high-performance embedded SQLite (WAL mode + FTS5 BM25 search), and local deterministic dense embeddings.

---

## 📊 Measured Token Footprint (`recall cost`)

Never trust unmeasured claims about "token savings". Run `recall cost` in any Recall-enabled repo to inspect the exact footprint:

```text
Always-on (sent with every agent turn):
  AGENTS.md (Recall block only)            ~   97 tok
  skill name + description                 ~   18 tok
  TOTAL                                    ~  115 tok (zero prompt bloat; no MCP schema tax)

On-demand (only when the agent asks):
  skill body                               ~  282 tok  (loaded when the agent picks the skill)
  `recall context` response                ~  400 tok  (hard cap)
  .recall/CURRENT_STATE.md                 ~  186 tok  (read only for continue/resume)
  .recall/PROJECT_MAP.md                   ~ 1500 tok  (production topology; test files excluded)
```

- **Byte-stable always-on rules:** Recall never writes dynamic session state into your always-on prompt, protecting your provider's prompt cache.
- **Pull, not push:** Agents never read `PROJECT_MAP.md` upfront; they call `recall where <name>` for targeted `file:line` rows (~50 tokens).
- **Capped context responses:** `recall context` returns compact hits capped at ~400 tokens.

---

## 🚫 When NOT to use Recall

Be realistic about whether your repository needs Recall:

- **Small repos (<15 files):** Your agent can already fit all relevant source files in its context window. Recall adds overhead for zero gain.
- **Single-file tasks or routine typo fixes:** Agents do not need to consult memory or search landmarks.
- **One-off exploratory scripts:** If code is discarded in hours, persistent memory provides no ROI.

**Where Recall actually pays off:**
- Repositories with files >300 lines of code (targeted `recall where` jumps).
- Non-obvious architectural invariants, API quirks, or rejected approaches that agents repeatedly get wrong across different chats.
- Multi-developer teams aligning multiple AI agents (Cursor, Antigravity, Claude Code, Windsurf) to the same project conventions.

---

## ✨ Features

- 🤖 **Autonomous AI Agent Automation**: Built for AI agents to do everything automatically. They fetch context, jump to symbols, record lessons, and checkpoint sessions through native commands and hooks. No manual logging.
- ⚡ **Init Once, Zero Maintenance**: Run `recall init` once. Scaffolds `.recall/` and installs cache-stable agent instructions.
- 🎯 **80–90%+ Context Preservation for Production Code**: Automatic test file filtering (`*.test.*`, `*.spec.*`, `test/`, `spec/`) ensures `PROJECT_MAP.md` and landmark anchors focus purely on production architecture.
- 🗂️ **Structured memory**: Decisions, lessons, conventions, bugfixes, failed approaches, and design tokens stored as plain Markdown.
- 🚀 **Zero MCP Bloat**: Pure CLI and native agent skill/rule execution avoids wasting ~184+ tokens of MCP tool schemas on every LLM prompt turn.
- 🔎 **Fast offline hybrid retrieval**: SQLite FTS5 BM25 search, technical identifier boost (+12 to +20), and local dense semantic vectors (`recall-dense-v1`), capped at ~400 tokens per lookup.
- 🧭 **Targeted symbol jumps**: `recall where <symbol>` returns live cached `file:line` rows instead of reading massive files into context.
- 🔄 **Autonomous de-duplication**: Repeated agent writes update existing memories in place rather than bloating future retrieval turns.
- 🛡️ **Zero-Network Security & Safety**: Shannon entropy and regex secret scanning, prompt injection defense, and multi-tenant/workspace isolation with zero external API calls. Non-destructive Git rollbacks via `recall undo`.

---

## 📦 Installation

**Requirements:** Node.js ≥ 20 and Git (recommended).

### From npm

```bash
npm install -g @vishnuvmx/recall-memory   # exposes the `recall` command
# or run without installing:
npx @vishnuvmx/recall-memory init
```

### From source

```bash
git clone https://github.com/vishnuvmx/recall-memory.git
cd recall-memory
npm install
npm run build
npm link    # exposes `recall` globally
```

---

## 🚀 Quick Start

```bash
cd /path/to/my-project

# 1. Initialize Recall in your repository
recall init

# 2. Add an architectural decision or lesson (or let your AI agent do it)
recall remember "Keep rendering separate from annotation state" --type decision --tag pdf

# 3. Retrieve context on demand
recall context "PDF annotation scaling"

# 4. Check repo memory health & status
recall status
```

---

## 🗃️ Directory Structure

Running `recall init` creates:

```text
.recall/
  config.json             # Core settings (e.g. target agent instruction file)
  MEMORY.md               # Human-curated invariants & negative architectural boundaries
  INDEX.md                # Generated catalog of active decisions, lessons, and conventions
  PROJECT_MAP.md          # Generated codebase topology, entry points, design tokens, landmarks
  CURRENT_STATE.md        # Single-snapshot iteration state (progress, active files, next steps)
  rules/                  # Project conventions and rules
  decisions/              # Architectural decision records
  lessons/                # Lessons learned and documented failed approaches
  tasks/                  # Task definitions and status
  sessions/
    session-log.md        # Rolling 14-day history of session checkpoints (auto-pruned as log grows)
  logs/
    CHANGELOG.md          # Local memory operation log
```

Memory files are Markdown with validated YAML frontmatter (`id, title, type, created, updated, tags, status, verification, sources`).

---

## 🧰 Commands Reference

| Command                                                              | What it does                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall init [--no-agent]`                                           | Scaffolds `.recall/`, maps the project, and installs lean, cache-stable agent instructions. One command; agents handle the rest.                           |
| `recall cost [--json]`                                               | Inspects the exact token footprint of Recall in your repo: always-on instructions vs on-demand lookups.                                                     |
| `recall where <name> [-n N]`                                         | Fast symbol & file locator. Returns live cached `file:line` rows so agents jump straight to code without reading `PROJECT_MAP.md`.                         |
| `recall remember <text> [-t title] [--type T] [--tag X]…`            | Saves a memory. Active immediately in default `auto` mode; similar titles update in place. Pass `--proposed` for review mode.                              |
| `recall context <task> [-n N] [--verbose] [--format json]`           | Local keyword, BM25, and dense embedding search. Returns compact results hard-capped at ~400 tokens by default. Pass `--verbose` for scores.              |
| `recall seed [--from git\|docs\|all] [-n N] [--dry-run]`              | Automatically mines Git commit history and documentation (`docs/`) into proposed architectural memories.                                                  |
| `recall review [--approve-all] [--archive-all]`                      | Optional audit command: inspects pending proposed memories and allows batch activation or archiving.                                                      |
| `recall approve <id>`                                                | Promotes a `proposed` memory to `active` (only needed if running in gated `review` mode).                                                                   |
| `recall archive <id>`                                                | Sets status to `archived`. Kept on disk for history but excluded from default search. Never deletes files.                                                 |
| `recall checkpoint [summary] [--auto] [--hook]`                      | Records an iteration snapshot. Run automatically by the agent `Stop` hook; manual invocation is optional.                                                 |
| `recall prune [--days D] [--max N]`                                  | Prunes entries in `session-log.md` older than the retention window (default: 14 days) or exceeding max entries (default: 50).                               |
| `recall status [--json]`                                             | Displays memory counts, index health, agent integration status, and uncommitted memory changes.                                                            |
| `recall map`                                                         | Regenerates `PROJECT_MAP.md` directory layout and file line landmarks (skipping test files to preserve production token context).                           |
| `recall rebuild`                                                     | Deterministically rebuilds `INDEX.md`. Preserves user notes outside markers; reports malformed files without deleting them.                                |
| `recall undo [--dry-run]`                                            | Safely discards uncommitted changes and removes untracked files in `.recall/`. Never touches gitignored files or project source code.                      |
| `recall doctor`                                                      | Diagnoses configuration, directories, frontmatter, map, state, and Git tracking. Suggests fixes without destructive auto-repairs.                          |

**Memory types:** `fact | decision | convention | lesson | bugfix | failed_approach | task | design_system`  
**Lifecycle:** `proposed | active | superseded | archived`  
**Verification:** `unverified | verified | needs_review`

---

## 🤖 Agent Compatibility

Recall integrates natively with modern AI coding agents using their built-in terminal environments, rule files, and skill directories:

| Agent / Tool           | Native File                          | How to Configure Recall                                                                                                                                                  |
| :--------------------- | :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Antigravity** | `.agents/rules/` + `.agents/skills/` | Native. `recall init` scaffolds an always-on rule (`.agents/rules/recall.md`) and on-demand skill (`.agents/skills/recall/SKILL.md`) alongside `AGENTS.md`.              |
| **Claude Code**        | `CLAUDE.md`                          | If `CLAUDE.md` exists, `recall init` appends `@AGENTS.md` into it. Otherwise add `@AGENTS.md` to `CLAUDE.md` or set `"agentFile": "CLAUDE.md"` in `.recall/config.json`. |
| **Cursor**             | `.cursorrules` / `AGENTS.md`         | Set `"agentFile": ".cursorrules"` in `.recall/config.json` or let Cursor read `AGENTS.md`.                                                                               |
| **Windsurf / Cascade** | `.windsurfrules` / `AGENTS.md`       | Reads `AGENTS.md` natively, or set `"agentFile": ".windsurfrules"`.                                                                                                      |
| **GitHub Copilot**     | `.github/copilot-instructions.md`    | Set `"agentFile": ".github/copilot-instructions.md"`.                                                                                                                    |

### Existing agent files

`recall init` uses explicit markers:

```markdown
<!-- recall:begin -->

... managed instructions ...

<!-- recall:end -->
```

If `AGENTS.md` already exists, any instructions outside those boundaries are strictly preserved.

---

## 🔍 How Hybrid Retrieval Works

Recall combines deterministic indexing, full-text BM25 search, and dense semantic embeddings with zero external network calls:

1. **Exact-Match Technical Identifier Boost**: Code identifiers (camelCase, PascalCase, snake_case), error codes (`ERR_...`, `SQLITE_...`, `EEXIST`), filenames (`*.ts`, `Dockerfile`), and CLI commands receive high priority boost (+12 to +20).
2. **BM25 Keyword Matching**: Full-text indexing using SQLite FTS5 with Porter stemming and BM25 ranking across titles, tags, and document bodies.
3. **Dense Vector Semantic Similarity**: Local deterministic subword embedding generation (`recall-dense-v1`) with cosine similarity, bridging vocabulary mismatch without external cloud APIs.
4. **Recency Weighting & Confidence Gating**: Exponential decay favoring fresh memories while weighting by confidence scores and verification status. Outdated or expired facts are automatically filtered out.
5. **Multi-Tenant & Workspace Isolation**: Queries strictly enforce `tenantId` and `workspaceId` boundaries, preventing cross-project memory leakage.
6. **Token-Budget Cap**: Search outputs are strictly capped at ~400 tokens / 1,600 characters to prevent context dilution.


---

## 🌐 Supported Landmark Languages

The landmark engine parses symbols in files with 300+ lines across:

| Language                    | Extensions                | Symbols                                                   |
| --------------------------- | ------------------------- | --------------------------------------------------------- |
| **Dart**                    | `.dart`                   | Classes, states, widget `build` methods, handlers         |
| **Kotlin**                  | `.kt`                     | Classes, data classes, `suspend fun`, objects, interfaces |
| **Java**                    | `.java`                   | Classes, interfaces, public/protected methods             |
| **Swift**                   | `.swift`                  | Classes, structs, protocols, `func`                       |
| **TypeScript / JavaScript** | `.ts` `.tsx` `.js` `.jsx` | Classes, exported functions, arrow components, methods    |
| **Python**                  | `.py`                     | Classes, `def` functions                                  |
| **Go**                      | `.go`                     | Struct types, functions/methods                           |
| **Rust**                    | `.rs`                     | Structs, enums, traits, `fn`                              |
| **C#**                      | `.cs`                     | Classes, interfaces, structs, records, `async` methods    |
| **C / C++**                 | `.c` `.cpp` `.h` `.hpp`   | Classes, structs, functions                               |
| **PHP**                     | `.php`                    | Classes, interfaces, traits, functions/methods            |
| **Ruby**                    | `.rb`                     | Classes, modules, `def` methods                           |

Unsupported file types are still mapped in the directory tree; symbol landmarking is skipped cleanly without error.

---

## 📏 Token Budgets & Priority Truncation

| Document           | Target Footprint    | Guardrail                                                                                  |
| :----------------- | :------------------ | :----------------------------------------------------------------------------------------- |
| `CURRENT_STATE.md` | ~200–300 tokens     | Capped single snapshot. History streams to `session-log.md` (rolling 14-day window).      |
| `session-log.md`   | Rolling window      | Auto-pruned beyond 14 days or 50 entries to keep disk and context lean.                     |
| `PROJECT_MAP.md`   | ~1,500–1,700 tokens | Priority truncation protects landmarks first. Hard ceiling of 5,600 chars (~1,500 tokens). |
| `MEMORY.md`        | ~300–500 tokens     | Human-curated invariants only. Recommended < 4 KB.                                         |
| `AGENTS.md` block  | ~400–450 tokens     | Recommended < 4 KB.                                                                        |

**Total initial orientation footprint:** Typically **1,500–3,000 tokens** across files.

---

## ⚠️ Known Limitations & Trade-offs

1. **Mid-task line drift:** `recall checkpoint` recalculates landmarks at session end, but mid-task edits shift lines below the edit. Treat landmarks as symbol anchors (`L5240: _toggleEditMode`) with a rough ±50-line window, and search for the symbol nearby rather than reading the whole file.
2. **Silent sequential ID collisions across branches:** Memory IDs increment sequentially (`mem_001`, `mem_002`, etc.). Because filenames include title slugs (e.g. `mem_015-auth.md` vs `mem_015-cache.md`), Git sees two distinct files and will merge them without conflict. The collision is silent until `recall doctor` or `recall status` reports a duplicate ID, requiring manual renumbering of one file.
3. **Local vs. shared state:** `CURRENT_STATE.md` and `sessions/` are local to your machine and branch. They do not sync across teammates or fresh clones.
4. **Proposal gate bypass with shell access:** The stdio MCP interface strictly uses `recall_propose` (`proposed`), and `RECALL_AGENT=1` forces `proposed` status across operations. However, any agent operating with direct shell access can pass `--active` or write Markdown files directly to disk. Human code review on Pull Requests remains the primary line of defense.
5. **Cold start memory extraction:** `recall init` scaffolds an empty structure. Bootstrapping decisions from Git history or docs requires running `recall seed` or manually authoring records.

---

## ⚖️ Why Not Just Use X?

| Alternative                         | Difference                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plain `AGENTS.md` / `CLAUDE.md`** | A monolithic rules file grows monotonically and costs prompt budget every turn. Recall adds modular records, on-demand retrieval, codebase topology, and a proposal gate. |
| **Aider's Repo Map**                | Aider builds an in-memory Tree-sitter map per session. Recall adds persistent, Git-versioned decisions, design tokens, bugfix history, and iteration progress.            |
| **Claude Code auto-memory**         | Machine-local (`~/.claude/`), unversioned, not shared. Recall lives in `.recall/`, versioned in Git and usable across all AI tools.                                       |
| **Cursor codebase index**           | Proprietary cloud vector embeddings. Recall is 100% offline, zero-cost, and reviewable via `git diff`.                                                                    |

---

## 🛠️ Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
npm run bench        # run benchmarks
```

### Project layout

```text
src/
  cli/         # Commander-based CLI entry (recall ...)
  core/        # Embedded SQLite store, hybrid retrieval, conflict resolution, write queue, memory store, landmarks, mapper
  security/    # Prompt poisoning detection, Shannon entropy & regex secret scanning, multi-tenant isolation
  schemas/     # Zod schemas for metadata, lifecycle, and config
  templates/   # Scaffolding templates for `recall init`
  utils/       # Redacting logger and filesystem helpers
docs/          # Architecture, benchmarks, security specifications
scripts/       # Benchmark scripts
```


**Tech stack:** TypeScript (ESM), [Commander](https://github.com/tj/commander.js), [gray-matter](https://github.com/jonschlinkert/gray-matter), [Zod](https://zod.dev).

---

## 📚 Documentation

- [Documentation Overview](docs/README.md): summary of specifications, benchmarks, and threat models.
- [Architecture & Technical Specification](docs/ARCHITECTURE.md): orientation loop, landmark protocol, competitor matrix, retrieval mechanics.
- [Empirical Benchmarks & Token Experiments](docs/BENCHMARKS.md): hardware benchmarks, 80k-LOC metrics, token orientation model.
- [Security & Governance Model](docs/SECURITY.md): threat model, memory-poisoning defense, secret scanning, CODEOWNERS governance.

---

## 🤝 Contributing

Contributions are welcome!

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, development guidelines, and pull request procedures. All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

Please open an issue first for large changes or architectural proposals. Never include credentials or secrets in memory files or commits.

---

## 🔒 Security

Recall performs no network calls and rejects secret-looking content in memories via regex scanning. To report a vulnerability, please open a private security advisory on GitHub rather than a public issue. See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

---

## 📄 License

Released under the [MIT License](LICENSE).
