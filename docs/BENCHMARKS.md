# Recall Benchmarks & Performance Analysis

This document provides reproducible performance benchmarks, chronological latency distributions, and an analytical model comparing orientation token consumption across different agent memory strategies.

---

## 1. Hardware & Test Environment

All benchmarks were recorded on a local development workstation using the automated script [`scripts/benchmark.js`](../scripts/benchmark.js):

* **CPU**: 12th Gen Intel(R) Core(TM) i5-12450H (8 cores / 12 threads @ 2.50 GHz base)
* **RAM**: 16 GB DDR4
* **Disk**: 512 GB PCIe NVMe M.2 SSD
* **OS**: Windows 11 Pro 64-bit (Build 26200)
* **Runtime**: Node.js v24.12.0
* **Reproduction Command**: `npm run bench` or `node scripts/benchmark.js <path-to-repo>`

---

## 2. Target Repositories Under Test

Measurements were conducted across three local codebases:

| Metric | Target 1: `recall` (CLI Tool) | Target 2: `edita` (Mobile App) | Target 3: `edita.tools` (Web App) |
| :--- | :--- | :--- | :--- |
| **Domain** | Systems / Developer Tooling CLI | Production Document & Presentation App | Next.js / React Web Application |
| **Tech Stack** | TypeScript, Node.js, Vitest | Flutter (Dart), Android (Kotlin / Java) | TypeScript, Next.js, React, Tailwind |
| **Tracked Source Files** | 24 source files | **226 source files** | **124 source files** |
| **Lines of Code (LOC)** | 3,420 lines | **80,709 lines** | **18,450 lines** |
| **Subdirectories** | 8 directories | **65 nested directories** | **22 nested directories** |
| **Architecture** | Flat modular packages | Multi-module Android (`app`, Gradle), Dart services | Next.js App Router (`src/app/`, `src/components/`) |

---

## 3. Chronological Latency Measurements

The following raw measurements represent 5 consecutive, unsorted iterations executed directly by `scripts/benchmark.js`. Statistics report **Sample Standard Deviation ($s$)** using Bessel's correction ($N - 1$):

```text
------------------------------------------------------------------------------------------------------
Iteration          Target 1: Recall CLI       Target 2: Edita App         Target 3: Edita.tools (Web)
------------------------------------------------------------------------------------------------------
Run 1              36.71 ms                   140.13 ms                   185.88 ms
Run 2              17.10 ms                    75.32 ms                   156.61 ms
Run 3              15.79 ms (Median)           75.53 ms                   145.42 ms (Median)
Run 4              15.77 ms                    73.97 ms                   145.26 ms
Run 5              15.35 ms (Min)              73.62 ms (Min)             144.09 ms (Min)
------------------------------------------------------------------------------------------------------
Min                15.35 ms                    73.62 ms                   144.09 ms
Median             15.79 ms                    75.32 ms                   145.42 ms
Mean               20.15 ms                    87.71 ms                   155.45 ms
Sample SD (s)      ±9.29 ms                   ±29.31 ms                   ±17.76 ms
Max                36.71 ms                   140.13 ms                   185.88 ms
------------------------------------------------------------------------------------------------------
```

### Deterministic Keyword Retrieval Speed
* **Dataset**: 100 structured memory documents (rules, ADRs, debugging lessons).
* **Workload**: 1,000 multi-token search queries (`"jwt token authentication security"`).
* **Average Latency per Query**: **~0.20–0.24 ms (~200–240 microseconds)**

---

## 4. Hard Output Budget Enforcement

Recall enforces a strict character ceiling in `buildProjectMapMarkdown` (default content cap: 5,600 characters $\approx$ 1,500–1,700 tokens). 

> **Token Conversion Caveat:** Source code, paths, and punctuation tokenize less efficiently than standard English prose (~3.5–3.8 characters per token vs 4.0). A 5,600-character ceiling corresponds to roughly **1,500–1,700 tokens**.

If directory trees or landmarks exceed this threshold, the output truncates gracefully with an explicit notice to protect prompt budgets, dropping tree structures first and preserving high-value line landmarks.

### Output Metrics Across Repositories

| Repository | LOC | Raw Output Size | Line Count | Budget Constraint | Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Recall CLI** | 3.4k LOC | 1,826 bytes | 77 lines | $\le$ 6,000 bytes | **Passed** |
| **Edita Mobile App** | 80.7k LOC | 5,078 bytes | 169 lines | $\le$ 6,000 bytes | **Passed** |
| **Edita.tools Web App** | 18.5k LOC | 5,593 bytes | 180 lines | $\le$ 6,000 bytes | **Passed** |

---

## 5. Theoretical Projections (Analytical Model — Not Measured LLM Execution Logs)

> ⚠️ **Projection Notice:** The table below is a theoretical estimation comparing tool-call paths across three development workflows, **not an empirically measured LLM agent execution log**. Token counts and calls represent approximations. For empirical measurements, see Sections 3 and 4 above.

### Comparative Framework (3 Arms Evaluated)
1. **Arm A: Baseline (Cold Exploration)**: Empty agent memory; agent must discover repository layout via recursive `list_dir`, broad `grep_search`, and exploratory file reads.
2. **Arm B: Plain `AGENTS.md`**: Monolithic static file with a 20-line hand-written folder overview. Agent knows high-level folder roles, but lacks symbol landmarks and specific file line targets.
3. **Arm C: Recall**: Structured memory with `PROJECT_MAP.md` (topology & symbol landmarks) and deterministic keyword retrieval (`recall context`).

### Analytical Comparison Across 5 Sample Tasks

*Accounting Note: In Arm C, tool calls strictly include reading `PROJECT_MAP.md` (or calling `recall context`), followed by the direct target read.*

| Task Description | Arm A: Baseline (No Memory)<br>Calls \| Tokens | Arm B: Plain AGENTS.md<br>Calls \| Tokens | Arm C: Recall<br>Calls \| Tokens | Key Structural Difference |
| :--- | :---: | :---: | :---: | :--- |
| **1. UI Dark Mode Theme Tokens**<br>Find color tokens and update widgets | 4 calls \| ~7,500 tok<br>*(list_dir $\times$ 2, grep, view)* | 2 calls \| ~3,200 tok<br>*(grep for Theme, view)* | **2 calls \| ~2,400 tok**<br>*(read map, direct view)* | Plain `AGENTS.md` names `lib/utils/`; Recall points directly to `app_theme.dart`. |
| **2. Native Android Audio Service Bridge**<br>Locate Kotlin MethodChannel handler | 5 calls \| ~9,200 tok<br>*(list_dir $\times$ 3, grep, view)* | 3 calls \| ~4,500 tok<br>*(list_dir android, grep, view)* | **2 calls \| ~2,500 tok**<br>*(read map landmark, direct view)* | Recall provides the exact Kotlin file and symbol landmark anchor. |
| **3. PDF Annotation Zoom Scaling Bug**<br>Locate coordinate matrix transformation | 4 calls \| ~11,400 tok<br>*(grep 4.5k tok, 2 view slices)* | 3 calls \| ~5,800 tok<br>*(grep for matrix, view slices)* | **2 calls \| ~2,100 tok**<br>*(recall context $\to$ direct read)* | Plain `AGENTS.md` cannot store past debugging lessons without file bloat. |
| **4. Presentation Slide Reordering**<br>Find PresentationModel serialization | 2 calls \| ~3,800 tok<br>*(list_dir models, view)* | 2 calls \| ~3,400 tok<br>*(read AGENTS.md, view)* | **2 calls \| ~2,300 tok**<br>*(read map landmark, direct view)* | On small models, Plain `AGENTS.md` and Recall perform similarly. |
| **5. PPTX / PDF Presentation Export Bridge**<br>Locate export serialization pipelines | 3 calls \| ~6,400 tok<br>*(grep, 2 exploratory reads)* | 2 calls \| ~3,600 tok<br>*(grep in services, view)* | **2 calls \| ~2,400 tok**<br>*(read map landmark, direct view)* | Recall landmarks point directly to `_exportPdf` inside a 1,200-line screen file. |

### Analysis: Where Recall Diverges from Plain `AGENTS.md`
1. **On Small / Routine Tasks**: A well-maintained plain `AGENTS.md` performs reasonably well (2-3 tool calls). Recall's advantage on small tasks is modest.
2. **On Large Files ($\ge 500$ LOC)**: Plain `AGENTS.md` points to the file, but the agent still has to grep or read multiple chunks to find target logic. Recall's symbol line landmarks allow direct jumps.
3. **On Multi-Month Institutional Knowledge**: Plain `AGENTS.md` grows monotonically. Adding 20 architectural decisions and 15 debugging lessons turns `AGENTS.md` into a massive file that wastes tokens on every turn. Recall keeps the root small and retrieves decisions on demand via `recall context`.
