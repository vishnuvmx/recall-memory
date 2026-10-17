<div align="center">

<p align="center">
  <img src="recall.png" alt="Recall Logo" width="100" />
</p>

# Recall: Git-Friendly Project Memory for AI Coding Agents

**Local-first, Git-friendly project memory for AI coding agents.**

Markdown-based decisions, conventions, and codebase topology — retrieved on demand.  
Your agent does the reasoning; Recall does the remembering.

<!-- Badges -->

[![Status: Alpha](https://img.shields.io/badge/status-alpha%20(v0.1.0)-orange.svg)](#-about)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![Local only](https://img.shields.io/badge/network-zero%20calls-success)](docs/SECURITY.md)
[![Git Backed](https://img.shields.io/badge/storage-local%20Git%20markdown-orange?logo=git&logoColor=white)](docs/ARCHITECTURE.md)
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
- [Cold Start & Seeding](#-cold-start--seeding)
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
> **Status: Alpha (v0.1.0)**. Recall's core CLI, local retrieval engine, and `.recall/` file schemas are functional and thoroughly tested. APIs and tooling integrations are evolving. We welcome feedback and contributions!

AI coding agents forget everything between sessions and waste tokens re-scanning your repository. **Recall** gives them a persistent, reviewable memory that lives inside your repo as plain Markdown in `.recall/`.

- **No network calls at runtime**, no telemetry, no LLM SDK, no vector database.
- **Git provides history.** Every memory is a file you can diff, review, and revert.
- **Agents stay in control of reasoning.** Recall only organizes and retrieves knowledge: decisions, conventions, line landmarks, and failed approaches.

> [!TIP]
> **Honest scope:** Recall shines on large files (>300 LOC), multi-month projects, and team code governance. On small repositories (<15 files) or routine single-file tasks, its advantage is modest or negligible.

---

## 🌱 Cold Start & Seeding
 
To build meaningful memory from day one without manually typing out architectural records:
 
1. **Automated Seeding (`recall seed`):** Analyze your recent git commits and repository documentation (`docs/`) to auto-propose initial architectural decisions and bugfixes:
   ```bash
   recall seed               # mines git history and docs/ into proposed memories
   recall seed --from docs   # only inspect documentation files
   recall seed --dry-run     # preview what would be proposed without saving
   ```
2. **Review & Batch Approval (`recall review`):** Inspect the mined proposals and approve them in one step:
   ```bash
   recall review             # inspect pending proposed memories
   recall review --approve-all   # activate all proposals to index them for search
   ```
3. **Iterative Accumulation:** As your team and agent encounter tricky bugfixes or reject approaches, record them (`recall remember "..." --type failed_approach` or `--type lesson`) to protect future turns.

---

## ✨ Features

- 🗂️ **Structured memory**: decisions, lessons, conventions, bugfixes, failed approaches, tasks, and design tokens.
- 🔎 **Fast offline retrieval**: deterministic keyword search with suffix stemming and field weighting (~0.2 ms lookup, no vector database).
- 🧭 **Codebase topology**: auto-generated `PROJECT_MAP.md` mapping directory layouts and symbol landmarks for files >300 LOC.
- ✅ **Human-gated proposals**: agent MCP tool calls propose changes (`proposed`); humans approve them (`active`).
- 🔌 **Native MCP server**: stdio server exposing context search, proposals, checkpointing, and mapping.
- 🤝 **Broad agent support**: Antigravity, Claude Code, Cursor, Windsurf, Copilot, and custom agents.
- 🛡️ **Safety guardrails**: best-effort secret regex scanning, non-destructive Git operations, and safe rollback via `recall undo`.
- 💸 **Disciplined footprint**: orientation footprint typically constrained between 1,500–3,000 tokens.

---

## 📦 Installation

**Requirements:** Node.js ≥ 20 and Git (recommended).

### From npm (available from the 22 Oct launch)

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

# 2. Add an architectural decision or lesson
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
| `recall init [--no-agent]`                                           | Scaffolds `.recall/`, maps the project, initializes state, and installs the anti-scan protocol in `AGENTS.md`. Preserves existing content outside markers. |
| `recall seed [--from git\|docs\|all] [-n N] [--dry-run]`              | Automatically mines Git commit history and documentation (`docs/`) into proposed architectural memories. Solves the cold-start problem.                   |
| `recall review [--approve-all] [--archive-all]`                      | Lists pending proposed memories and allows batch activation or archiving.                                                                                  |
| `recall map`                                                         | Re-scans the repository (respecting `.gitignore`) up to depth 3. Regenerates `PROJECT_MAP.md` and file line landmarks.                                     |
| `recall checkpoint [summary] [--auto] [-n next]`                     | Records an iteration snapshot into `CURRENT_STATE.md`, streams history to `session-log.md` (rolling 14-day retention), and auto-refreshes landmarks.        |
| `recall prune [--days D] [--max N]`                                  | Prunes entries in `session-log.md` older than the retention window (default: 14 days) or exceeding max entries (default: 50).                               |
| `recall remember <text> [-t title] [--type T] [--tag X]… [--active]` | Saves exact text as a memory note (`proposed` by default; pass `--active` for immediate active status). Rejects secret-looking content.                    |
| `recall propose <text> -t title [--type T]`                          | Saves memory with status `proposed`. Excluded from search until promoted by a human.                                                                       |
| `recall approve <id>`                                                | Promotes a `proposed` memory to `active`, indexing it for future retrieval.                                                                                |
| `recall archive <id>`                                                | Sets status to `archived`. Kept on disk for history but excluded from default search. Never deletes files.                                                 |
| `recall context <task> [-n N] [--type T] [--tag X] [--format json]`  | Local keyword, tag, and suffix-stemmed search. Ranks title, tag, heading, body hits, and recency.                                                          |
| `recall status [--json]`                                             | Displays memory counts, orientation token footprint against budget (~3,000 max), agent integration, and uncommitted changes.                              |
| `recall log [-n N]`                                                  | Displays read-only Git history for `.recall/` (or falls back to local changelog).                                                                          |
| `recall rebuild`                                                     | Deterministically rebuilds `INDEX.md`. Preserves user notes outside markers; reports malformed files without deleting them.                                |
| `recall undo [--dry-run]`                                            | Safely discards uncommitted changes and removes untracked files in `.recall/`. Never touches gitignored files or project source code.                      |
| `recall doctor`                                                      | Diagnoses configuration, directories, frontmatter, map, state, and Git tracking. Suggests fixes without destructive auto-repairs.                          |
| `recall serve`                                                       | Local stdio MCP server exposing `recall_context`, `recall_propose`, `recall_checkpoint`, `recall_map`, and `recall_status`.                                |

**Memory types:** `fact | decision | convention | lesson | bugfix | failed_approach | task | design_system`  
**Lifecycle:** `proposed | active | superseded | archived`  
**Verification:** `unverified | verified | needs_review`

---

## 🤖 Agent Compatibility

| Agent / Tool           | Native File                          | How to Configure Recall                                                                                                                                                  |
| :--------------------- | :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Antigravity** | `.agents/rules/` + `.agents/skills/` | Native. `recall init` scaffolds an always-on rule (`.agents/rules/recall.md`) and on-demand skill (`.agents/skills/recall/SKILL.md`) alongside `AGENTS.md`.              |
| **Claude Code**        | `CLAUDE.md`                          | If `CLAUDE.md` exists, `recall init` appends `@AGENTS.md` into it. Otherwise add `@AGENTS.md` to `CLAUDE.md` or set `"agentFile": "CLAUDE.md"` in `.recall/config.json`. |
| **Cursor**             | `.cursorrules` / `AGENTS.md`         | Set `"agentFile": ".cursorrules"` in `.recall/config.json` or let Cursor read `AGENTS.md`.                                                                               |
| **Windsurf / Cascade** | `.windsurfrules` / `AGENTS.md`       | Reads `AGENTS.md` natively, or set `"agentFile": ".windsurfrules"`.                                                                                                      |
| **GitHub Copilot**     | `.github/copilot-instructions.md`    | Set `"agentFile": ".github/copilot-instructions.md"`.                                                                                                                    |
| **Any MCP Client**     | Stdio MCP                            | Register `recall serve` in your editor's MCP settings.                                                                                                                   |

Example MCP configuration:

```json
{
  "mcpServers": {
    "recall": { "command": "recall", "args": ["serve"] }
  }
}
```

### Existing agent files

`recall init` uses explicit markers:

```markdown
<!-- recall:begin -->

... managed instructions ...

<!-- recall:end -->
```

If `AGENTS.md` already exists, any instructions outside those boundaries are strictly preserved.

---

## 🔍 How Retrieval Works Without Embeddings

Recall avoids vector databases and remote embedding APIs by combining deterministic indexing with local linguistic normalization:

1. **Tokenization & stopwords:** strips punctuation, normalizes case, filters common English stopwords.
2. **Suffix stemming:** words with common suffixes (`-ing`, `-ed`, `-s`, `-es`, `-ies`) match root forms (query `"scale"` matches `"scaling"`; `"token"` matches `"tokens"`).
3. **Field weighting:** exact title (15 pts) > partial title (8) > tag match (2) > heading match (2) > body occurrence (1 each, max 3).
4. **Lifecycle & verification boosts:** active memories get full score; verified memories get +0.5; proposed and superseded are discounted; archived are excluded by default.

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
5. **No automated seeding command:** `recall init` scaffolds an empty memory structure. Extracting initial decisions from existing ADRs or commit history is a manual prompting exercise rather than a built-in automated command.

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
npm test             # run the Vitest suite
npm run bench        # run benchmarks
```

### Project layout

```text
src/
  cli/         # Commander-based CLI entry (recall ...)
  core/        # Memory store, search, map, git, checkpoint logic
  mcp/         # Stdio MCP server
  schemas/     # Zod schemas for frontmatter and config
  templates/   # Scaffolding templates for `recall init`
  utils/       # Shared helpers
tests/         # Vitest test suite
docs/          # Architecture, benchmarks, security specifications
scripts/       # Benchmark scripts
```

**Tech stack:** TypeScript (ESM), [Commander](https://github.com/tj/commander.js), [gray-matter](https://github.com/jonschlinkert/gray-matter), [Zod](https://zod.dev), [Vitest](https://vitest.dev).

---

## 📚 Documentation

- [Architecture & Technical Specification](docs/ARCHITECTURE.md): orientation loop, landmark protocol, competitor matrix, retrieval mechanics.
- [Empirical Benchmarks & Token Experiments](docs/BENCHMARKS.md): hardware benchmarks, 80k-LOC metrics, token orientation model.
- [Security & Governance Model](docs/SECURITY.md): threat model, memory-poisoning defense, secret scanning, CODEOWNERS governance.

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repository and create a feature branch: `git checkout -b feat/my-change`
2. Make your changes and add tests under `tests/`.
3. Ensure `npm run typecheck` and `npm test` pass.
4. Commit with a clear message and open a Pull Request describing the change and motivation.

Please open an issue first for large changes or new features. Never include credentials or secrets in memory files or commits.

---

## 🔒 Security

Recall performs no network calls and rejects secret-looking content in memories via regex scanning. To report a vulnerability, please open a private security advisory on GitHub rather than a public issue. See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

---

## 📄 License

Released under the [MIT License](LICENSE).
