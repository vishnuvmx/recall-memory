# Contributing to Recall

Thank you for your interest in contributing to Recall! Recall is a local-first, Git-friendly persistent project memory for AI coding agents.

## Development Setup

### Prerequisites
- Node.js >= 20
- Git

### Getting Started

```bash
git clone https://github.com/vishnuvmx/recall-memory.git
cd recall-memory
npm install
npm run build
npm test
```

> **Note on Git Hooks**: `npm install` automatically activates the project hooks via the `prepare` script (`git config core.hooksPath .githooks`). If you skipped lifecycle scripts, enable them manually:
> ```bash
> git config core.hooksPath .githooks
> ```
> This ensures pre-commit checks (`typecheck`) and post-checkout hooks run locally. All checks are also enforced in GitHub Actions CI.

## Workflow & Guidelines

1. **Fork & Branch**: Create a feature branch off `main` (`git checkout -b feat/your-feature` or `fix/your-bug`).
2. **Strict Invariants**:
   - **Zero Network Calls**: Recall must never make external network calls, transmit telemetry, or depend on remote vector databases.
   - **Plain Markdown & Git**: Knowledge must stay human-readable and Git-reviewable.
   - **Minimal Dependencies**: We intentionally keep dependencies minimal (`commander`, `gray-matter`, `ignore`, `zod`). Avoid adding heavy native dependencies or LLM SDKs.
3. **Tests & Quality**:
   - Add unit/integration tests under `tests/` for any new logic or bugfixes.
   - Ensure `npm run typecheck`, `npm run build`, and `npm test` pass cleanly.
4. **Pull Requests**:
   - Provide a clear PR title and description explaining the problem and motivation.
   - Never commit API keys, credentials, or private keys.
