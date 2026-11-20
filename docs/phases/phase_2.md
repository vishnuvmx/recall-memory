# PHASE 2 — NATIVE AGENT INTEGRATION AUDIT

Investigate the existing Recall integration with Google Antigravity and Gemini.

The desired user experience:

- Install Recall.
- Open Antigravity.
- Open a new conversation.
- Recall automatically provides relevant project knowledge.
- Continue working normally.
- Important knowledge is persisted automatically.
- No manual commands.
- No MCP configuration.
- No manual memory retrieval.

Investigate the actual supported integration mechanisms available in the installed Antigravity environment.

Do not assume Gemini CLI capabilities are available inside Antigravity.

Investigate:

1. Native agent rules.
2. Native agent skills.
3. Supported lifecycle hooks.
4. Session initialization events.
5. Context-loading capabilities.
6. Session completion or persistence events.
7. Whether integrations execute automatically.
8. Whether context is actually delivered to the model.

Perform a fresh-session experiment.

Use a unique test fact stored in Recall that is not included in the user's new conversation prompt.

Collect evidence for these separate stages:

A. Integration activated.
B. Recall accessed.
C. Knowledge retrieved.
D. Context delivered to the model.
E. Model used the retrieved information.

Do not treat a correct AI answer as proof of automatic context injection.

If the host does not expose sufficient observability, explicitly report that limitation.

Deliver:

- Integration architecture.
- Actual supported APIs and mechanisms.
- Source-code references.
- Fresh-session test results.
- Automatic loading limitations.
- Recommended native integration strategy.

Do not modify files. Wait for approval.
