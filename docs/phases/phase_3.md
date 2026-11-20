# PHASE 3 — RECALL ARCHITECTURE RECONSTRUCTION

Based on the approved findings from Phases 1 and 2, design a minimal reconstruction of Recall.

Core product definition:

Recall is an automatic, local-first project intelligence and continuity system for AI coding agents.

It should eliminate repeated project analysis, preserve important technical knowledge and automatically provide relevant context across conversations.

Requirements:

1. No MCP.
2. No user-facing CLI workflow.
3. No manual memory retrieval.
4. No unnecessary external services.
5. No mandatory cloud LLM APIs.
6. No duplicated conversation summaries.
7. No repeated full-project analysis.
8. Native Antigravity/Gemini compatibility wherever supported.
9. Preserve existing working SQLite, FTS5 and retrieval functionality where appropriate.
10. Maintain portability across different AI coding environments where technically possible.

Design:

- Background application/service.
- Native environment integration.
- Persistent project index.
- Incremental file indexing.
- Project knowledge storage.
- Automatic context preparation.
- Automatic memory capture where supported.
- Verification and diagnostics.

Investigate whether CURRENT_STATE.md is necessary or whether its responsibilities should be replaced by native session continuity and durable project knowledge.

For every proposed architectural change, explain:

- Existing problem.
- Current implementation.
- Proposed solution.
- Compatibility implications.
- Performance impact.
- Migration requirements.

Produce an architecture diagram and module-level implementation plan.

Do not modify source files until approval.
