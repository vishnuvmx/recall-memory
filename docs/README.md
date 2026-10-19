# Recall Documentation

This directory contains technical specifications, architectural designs, security invariants, and benchmark methodologies for the Recall project.

---

## 📚 Documents Overview

| Document | Description |
| :--- | :--- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical architecture specification: agent orientation loop, line landmark drift protocol, team Git strategy, and retrieval mechanics. |
| [BENCHMARKS.md](BENCHMARKS.md) | Reproducible benchmark measurements: chronological indexing latency distributions, token budget ceilings, and prompt footprint analysis (`recall cost`). |
| [SECURITY.md](SECURITY.md) | Security model & threat analysis: memory poisoning mitigations, write governance modes (`auto` vs. `review`), regex secret scanning heuristics, and CODEOWNERS integration. |

---

## 🛠️ Reproducing Benchmarks

Benchmarks can be run locally using Node.js:

```bash
# Build the project first
npm run build

# Run benchmark suite against this repository
npm run bench

# Or evaluate against another repository path
node scripts/benchmark.js /path/to/another/repo
```
