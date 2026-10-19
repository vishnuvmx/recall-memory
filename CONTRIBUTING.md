# Contributing to Recall

Thank you for considering contributing to Recall! Recall is a local-first persistent project memory system for AI coding agents.

Contributions from the community are welcome. This guide outlines how to report issues, propose changes, set up local development, and submit pull requests.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Reporting Issues](#reporting-issues)
- [Proposing Changes](#proposing-changes)
- [Development Setup](#development-setup)
- [Development Guidelines](#development-guidelines)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Review Process](#review-process)

---

## 📜 Code of Conduct

All contributors and participants are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md) to maintain a respectful and welcoming environment.

---

## 🐛 Reporting Issues

If you encounter unexpected behavior, edge cases, or documentation inaccuracies:

1. **Search existing issues:** Check open and closed [GitHub Issues](https://github.com/vishnuvmx/recall-memory/issues) to avoid duplicate reports.
2. **Open a new issue:** If not already tracked, file a report with:
   - A clear, descriptive title.
   - Operating system and Node.js version (`node -v`).
   - Exact steps to reproduce the issue.
   - Actual behavior vs. expected behavior.
   - Relevant terminal output or error messages (ensure sensitive paths and keys are redacted).

---

## 💡 Proposing Changes

For major modifications, architectural shifts, or new commands, opening an issue to discuss the proposal beforehand is recommended. This helps align changes with the project scope before significant implementation effort is spent.

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js** >= 20.0.0
- **Git**

### Installation

```bash
# Clone the repository
git clone https://github.com/vishnuvmx/recall-memory.git
cd recall-memory

# Install dependencies
npm install

# Build the project
npm run build

# Run type checks
npm run typecheck
```

### Git Hooks

Running `npm install` configures local Git hooks via the `prepare` script (`git config core.hooksPath .githooks`).
- **pre-commit**: Runs `npm run typecheck` to prevent committing type errors.
- **post-checkout**: Refreshes `.recall/PROJECT_MAP.md` if `.recall/` exists in the repository.

---

## 📐 Development Guidelines

When contributing code:

1. **Zero External Network Calls**: Recall core operations run locally. Do not add external network calls, remote telemetry, or remote database requirements.
2. **Plain Markdown**: Stored memory must remain human-readable Markdown with validated YAML frontmatter.
3. **Lean Dependencies**: Maintain minimal external dependencies (`commander`, `gray-matter`, `ignore`, `zod`). Avoid heavy native bindings or framework runtimes.
4. **Static Token Invariants**: The always-on agent prompt block in `AGENTS.md` must stay compact and static across sessions to avoid busting LLM provider prompt caches.
5. **No Secrets**: Never commit credentials, private keys, access tokens, or sensitive user data.

---

## 🚀 Submitting Pull Requests

1. **Branching**: Create a branch off `main`:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bugfix-name
   ```
2. **Verify Changes**: Ensure build and typechecking pass cleanly:
   ```bash
   npm run typecheck
   npm run build
   ```
3. **Commit Messages**: Write clear, descriptive commit messages summarizing the rationale for changes.
4. **Open a PR**: Push to your fork and submit a Pull Request targeting `main`. Describe the problem solved, implementation details, and any trade-offs considered.

---

## 🔍 Review Process

Pull requests and issues are reviewed by project maintainers on a best-effort basis as availability permits. Submission of a pull request does not guarantee that the change will be merged or reviewed within a specific timeframe. Maintainers may request revisions, additional context, or design adjustments before merging.
