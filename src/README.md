# Recall Source Architecture

This directory contains the TypeScript source code for Recall.

---

## 🗂️ Module Structure

```text
src/
├── cli/           # CLI command definitions using Commander (entry: cli/index.ts)
├── core/          # Core memory engine, retrieval algorithms, SQLite store, Git integrations
│   ├── config.ts          # Configuration loading and defaults (.recall/config.json)
│   ├── conflict.ts        # Outdated facts, superseding, deprecation, and conflict detection
│   ├── embeddings.ts      # Deterministic local dense vectors and SHA-256 caching
│   ├── hybrid-retrieval.ts # Hybrid BM25, exact identifier matching, and dense vector search
│   ├── sqlite-store.ts    # Embedded SQLite WAL engine, FTS5 virtual tables, transactions
│   ├── write-queue.ts     # Serialized write queue and retry logic for database concurrency
│   ├── landmarks.ts       # Landmark parsers across 12 languages
│   ├── mapper.ts          # Repository topology and PROJECT_MAP.md generation
│   ├── memory.ts          # CRUD operations for Markdown memories with frontmatter
│   ├── retrieval.ts       # Deterministic keyword search with suffix stemming
│   ├── seed.ts            # Automated memory candidate extraction from git/docs
│   ├── service.ts         # Orchestration layer uniting core functions
│   └── where.ts           # Targeted symbol locator (recall where <name>)
├── security/      # Prompt poisoning defense, Shannon entropy secret scanning, isolation
├── schemas/       # Zod schemas for memory frontmatter and configuration
├── templates/     # Initial markdown templates used by `recall init`
├── utils/         # Token estimation, secret-redacting logger, and file helpers
└── index.ts       # Public library export entry point

```

---

## 🏗️ Build & Verification

```bash
# Compile TypeScript to dist/
npm run build

# Run TypeScript typechecks without emitting code
npm run typecheck
```

---

## 📌 Architectural Invariants

1. **Zero Runtime Network Calls**: All code executes locally. Never add remote telemetry, third-party network APIs, or cloud database dependencies.
2. **Minimal Dependencies**: The project deliberately relies on a minimal set of dependencies (`commander`, `gray-matter`, `ignore`, `zod`). Avoid introducing heavy native binaries or web framework runtimes.
3. **Cache Stability**: Changes to instructions injected into `AGENTS.md` must stay under ~120 tokens and remain static to avoid breaking LLM provider prompt caches.
