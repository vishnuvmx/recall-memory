# Architecture rules

1. Zero external network calls at runtime; `node:sqlite` is lazy-loaded so Node 20+ falls back cleanly without crashing.
2. Plain Markdown in `.recall/` is the source of truth; `.recall/.cache/` (SQLite FTS5 + fingerprints + landmarks) is derived and rebuildable.
3. Always-on orientation budget in `AGENTS.md` must remain static and strictly under 120 tokens.
