<!-- recall:passport:begin -->
# Project Passport (Non-Volatile Blueprint)

> **AI MODELS**: Non-volatile architecture, commands, module exports, and durable rules. Read this once per new chat instead of cold-scanning the repository. Use `recall where <symbol>` for exact line numbers and `recall context "<topic>"` for deeper history.

## 1. Identity & Tech Stack
- **Project**: `@vishnuvmx/recall-memory`
- **Purpose**: Zero-maintenance, local-first persistent project memory for AI coding agents.
- **Stack**: Node.js >=20 (ESM) · TypeScript
- **Runtime Dependencies**: `commander`, `gray-matter`, `ignore`, `zod`

## 2. Verified Commands
- `npm run build` → `tsc -p tsconfig.build.json`
- `npm run typecheck` → `tsc --noEmit`
- `npm run test` → `node --test tests/*.test.mjs`
- `npm run sync` → `node scripts/recall-sync.js`
- `npm run bench` → `node scripts/benchmark.js`
- `npm run context-pack` → `node scripts/recall-context-pack.js`

## 3. Non-Volatile Rules, Decisions & Invariants
- Local-first execution: Zero runtime network calls, zero telemetry, zero cloud vector stores.
- Non-volatile warm orientation: `.recall/PASSPORT.md` holds hash-fingerprinted stack, commands, module exports, and active rules so AI models never cold-scan ...
- Prompt-cache discipline: Always-on instructions (`AGENTS.md`) remain static and strictly under 120 tokens.
- Read-only Git ops: Never commit, push, or stage workspace code automatically.
- Zero external network calls at runtime; `node:sqlite` is lazy-loaded so Node 20+ falls back cleanly without crashing.
- Plain Markdown in `.recall/` is the source of truth; `.recall/.cache/` (SQLite FTS5 + fingerprints + landmarks) is derived and rebuildable.
- Always-on orientation budget in `AGENTS.md` must remain static and strictly under 120 tokens.
- TypeScript ES modules (`.js` relative import extensions required).
- Strict types; no unnecessary external npm dependencies.
- Defensive path resolution via `resolveInside`.
- **[decision] Local-first Git architecture**: Recall operates 100% locally with zero external network or telemetry calls. All persistent memory is stored as human-reviewable Markdown ... _(mem_001)_
- **[decision] Non-volatile Passport and multi-model chat sync**: PASSPORT.md stores hash-fingerprinted non-volatile identity, commands, module exports, and active rules (without line numbers or timestam... _(mem_002)_

## 4. Core Modules & Exported Surface
- `src/core/agent.ts`: `AgentState`, `agentFilePath`, `agentState`, `syncClaudeBridge`, `syncAllAgentIntegrations`
- `src/core/background-queue.ts`: `ConsistencyPolicy`, `BackgroundJob`, `BackgroundQueue`
- `src/core/chat-sync.ts`: `ParsedChatTurn`, `ExtractedInsight`, `SyncWorkspaceOptions`, `SyncWorkspaceReport`, `parseTranscriptTail`
- `src/core/checkpoint.ts`: `CheckpointOptions`, `CheckpointResult`, `SessionLogEntry`, `getCurrentTimestamp`, `parseSessionLogEntries`
- `src/core/config.ts`: `configPath`, `defaultConfig`, `loadConfig`, `writeConfig`
- `src/core/conflict.ts`: `ConflictCheckResult`, `isMemoryExpired`, `supersedeMemory`, `deprecateMemory`, `detectConflicts`
- `src/core/cost.ts`: `CostLine`, `CostReport`, `costReport`
- `src/core/doctor.ts`: `Check`, `runDoctor`
- `src/core/embeddings.ts`: `EmbeddingResult`, `hashContent`, `cosineSimilarity`, `generateLocalDenseVector`, `getOrGenerateEmbedding`
- `src/core/git.ts`: `GitInfo`, `gitInfo`, `recallChanges`, `repoChanges`, `Commit`
- `src/core/hybrid-retrieval.ts`: `HybridSearchOptions`, `HybridSearchHit`, `extractTechnicalIdentifiers`, `hybridSearch`, `formatHybridHitsCompact`
- `src/core/index-builder.ts`: `buildIndexBlock`, `indexPath`, `renderIndex`, `rebuildIndex`, `IndexState`
- `src/core/init.ts`: `InitReport`, `initProject`
- `src/core/landmarks.ts`: `Landmark`, `FileLandmarks`, `extractLandmarks`, `scanLandmarks`, `formatLandmarksMarkdown`
- `src/core/mapper.ts`: `DirectoryInfo`, `ProjectMapData`, `createGitignoreFilter`, `parseGitignore`, `ScanProjectOptions`
- `src/core/memory.ts`: `Memory`, `Problem`, `LoadResult`, `slugify`, `loadAll`
- _... (19 more modules — query `recall where <name>`)_
<!-- recall:passport:end -->
