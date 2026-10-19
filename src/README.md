# Recall Source Architecture

This directory contains the TypeScript source code for Recall.

---

## 🗂️ Module Structure

```text
src/
├── cli/           # CLI command definitions using Commander (entry: cli/index.ts)
├── core/          # Core memory engine, retrieval algorithms, and Git integrations
│   ├── config.ts      # Configuration loading and defaults (.recall/config.json)
│   ├── git.ts         # Read-only Git commands and commit inspection
│   ├── landmarks.ts   # AST-like regex landmark parsers across 12 languages
│   ├── mapper.ts      # Repository topology and PROJECT_MAP.md generation
│   ├── memory.ts      # CRUD operations for Markdown memories with frontmatter
│   ├── retrieval.ts   # Deterministic keyword search with suffix stemming
│   ├── seed.ts        # Automated memory candidate extraction from git/docs
│   ├── service.ts     # Orchestration layer uniting core functions
│   ├── state.ts       # Single-snapshot iteration state (CURRENT_STATE.md)
│   └── where.ts       # Targeted symbol locator (recall where <name>)
├── mcp/           # Stdio JSON-RPC 2.0 MCP server (tools: context, where, remember)
├── schemas/       # Zod schemas for memory frontmatter and configuration
├── templates/     # Initial markdown templates used by `recall init`
├── utils/         # Token estimation, formatting, and file helpers
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
