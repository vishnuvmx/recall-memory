# Changelog

All notable changes to `@vishnuvmx/recall-memory` are documented in this file.

## [0.5.0] - 2026-11-20

### Added
- **Native Antigravity lifecycle integration:** Registers both `SessionStart` and `Stop` hooks in `.agents/hooks.json`, supports Antigravity camelCase `hookEventName` payloads alongside Claude Code snake_case payloads, returns Antigravity `injectSteps`/`systemMessage` responses while preserving Claude Code output formatting, and resolves the Recall CLI reliably when hooks execute from `.agents/`.
- **Incremental v5 landmark cache:** Tracks file `mtimeMs`, `ctimeMs`, size, `.gitignore` state, and `.git/HEAD` to avoid redundant full-repository walks across turns.
- **Zero-dependency benchmark & evaluation harnesses (dev-only):** Added reproducible performance benchmarks (`scripts/benchmark.js`) and two-dataset retrieval + symbol lookup evaluation (`scripts/eval.js`).

### Changed
- **Incremental `Stop` hook & warm `where()` lookup:** Eliminated repeated repository walks and per-turn `PROJECT_MAP.md` regeneration; warm symbol lookups read directly from the cached landmark index without walking disk (`14/14` symbol recall across methods, typed arrows, constants, and multi-word queries).
- **Non-destructive ephemeral state:** `.recall/CURRENT_STATE.md` and `.recall/sessions/` are now gitignored by default and updated non-destructively; passively extracted chat insights are staged as `proposed` rather than silently promoted into active rules.
- **Default retrieval pipeline:** Disabled 64-dim MD5 dense vectors by default in favor of SQLite FTS5 BM25 + keyword search with a 25% relative score cutoff (`Precision@3`: `70.3%` Dataset A, `71.3%` Dataset B; `0%` distractor leaks), while keeping opt-in vector ablation available.
- **npm package cleanup:** Removed unused wrapper scripts (`scripts/recall-chat-hook.js`, `scripts/recall-context-pack.js`, `scripts/recall-sync.js`), repointed `npm run sync` to `node dist/cli/index.js sync`, removed dead internal code (`src/utils/secrets.ts`, `parseGitignore()`, private `updateEmbeddingInTx()`), and excluded dev-only `scripts/` from the published npm tarball.

### Fixed
- Filtered expired memories (`expiresAt`) out of keyword `search()` results consistently with hybrid retrieval.
- Synchronized `package-lock.json` and CLI `--version` metadata with the published package version.

## [0.4.0]

- Added sanitized `SessionStart` context injection, corpus tag co-occurrence expansion, non-blocking deduplication and conflict warnings, and embedded SQLite FTS5 store.
