# PHASE 4 — INTELLIGENT CONTEXT ENGINE

Implement the approved context-engine improvements.

Primary objective:

Prevent AI agents from repeatedly rediscovering information already available in Recall.

Requirements:

1. Build a persistent project index.
2. Track file hashes and modification timestamps.
3. Index only changed or newly created files.
4. Detect deleted and renamed files.
5. Use AST/symbol-level indexing where appropriate.
6. Maintain dependency relationships.
7. Retrieve task-relevant files rather than entire directories.
8. Reuse verified project knowledge.
9. Detect stale index entries.
10. Fall back to source inspection when confidence is insufficient.

A small UI fix should not trigger an unnecessary full-project analysis.

The system must distinguish:

- Relevant source files.
- Related dependencies.
- Existing project constraints.
- Previously verified implementation decisions.
- Unrelated files.

Implement efficient incremental indexing.

Do not use embeddings for everything. Use deterministic indexing, symbol lookup and keyword retrieval where they are sufficient.

If semantic retrieval is already implemented, benchmark it before replacing it.

Add tests for:

- Unchanged project.
- One modified file.
- Multiple modified files.
- Renamed files.
- Deleted files.
- Changed dependencies.
- Stale index recovery.

Measure files inspected, retrieval latency and indexing overhead.

Do not claim performance improvements without measured results.
