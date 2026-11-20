# PHASE 6 — CHANGE PROTECTION AND VERIFICATION

Implement an actual verification and change-protection system.

Primary objective:

Prevent AI coding agents from making unrelated, unnecessary or architecturally inconsistent modifications.

Requirements:

1. Establish task-specific change scopes.
2. Track files modified during an implementation.
3. Detect unrelated modifications.
4. Preserve project architecture.
5. Preserve design-system constraints.
6. Detect prohibited dependencies and UI patterns.
7. Identify potentially destructive changes.
8. Verify affected components.
9. Run relevant tests and builds.
10. Produce evidence-backed verification reports.

Project constraints must be stored as durable, structured knowledge.

Examples:

- Never introduce Android Material UI styling into a project that explicitly prohibits it.
- Preserve existing typography, spacing, colors and iconography.
- Avoid introducing new dependencies without justification.
- Do not refactor unrelated screens while fixing a small interaction.
- Do not replace working implementations unnecessarily.

Important:

Do not assume that warning an AI agent prevents it from making a change.

Investigate actual enforcement mechanisms available at the filesystem, Git and supported host-integration levels.

Distinguish between:

- Detecting a violation.
- Warning about a violation.
- Blocking a violation.
- Reverting a violation.

Do not promise protection against modifications that the system cannot actually prevent.

Add regression tests for each enforcement mechanism.
