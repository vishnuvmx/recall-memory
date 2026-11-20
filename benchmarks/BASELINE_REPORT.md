# Recall Application Benchmark Baseline Report (recall-bench-v1)

> **Generated**: `2026-11-20T06:49:09.760Z` · **Commit**: `1aaca5c (dirty)` · **Dataset**: `recall-bench-ds-v1`
> **Environment**: 12th Gen Intel(R) Core(TM) i5-12450H (12 cores) · Windows_NT 10.0.26300 (x64) · Node.js v24.12.0

## 1. Multi-Scale Initial Indexing (`initProject`)

| Fixture Tier | Source Files | Wall Time (ms) | CPU Time (ms) | Dirs Walked | Files Statted | Files Read | Bytes Read (KB) | Files Written |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **small** | 15 | 196 | 187 | 63 | 44 | 55 | 113.7 | 27 |
| **medium** | 80 | 182.71 | 126 | 93 | 174 | 120 | 891.8 | 27 |
| **large** | 240 | 308.73 | 203 | 93 | 494 | 280 | 3022.4 | 27 |

## 2. Lifecycle Hook & Incremental Sync Workloads (Medium 80-File, 30-Memory Project)

| Workload | p50 (ms) | Mean (ms) | p95 (ms) | SD (±ms) | CV% | Dirs Walked | Files Statted | Files Read | Bytes Read (KB) | Files Written |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SessionStart Hook (Cold + Query) | **43.372** | 45.977 | 61.228 | 10.679 | 23.2% | 8 | 43 | 44 | 19.6 | 1 |
| SessionStart Hook (Warm Cache) | **3.333** | 3.545 | 4.462 | 0.497 | 14% | 4 | 37 | 2 | 2.4 | 0 |
| Stop Hook (0 Files Changed / Q&A Turn) | **216.611** | 225.782 | 262.161 | 21.025 | 9.3% | 66 | 184 | 124 | 90.7 | 4 |
| Stop Hook (1 File Modified) | **243.306** | 252.437 | 308.843 | 33.254 | 13.2% | 120 | 266 | 130 | 175.1 | 5 |
| Stop Hook (5 Files Modified) | **243.989** | 245.669 | 281.332 | 27.464 | 11.2% | 120 | 264 | 133 | 192.5 | 5 |
| Stop Hook (File Rename / Delete) | **229.585** | 228.272 | 253.074 | 23.454 | 10.3% | 120 | 266 | 130 | 146.5 | 7 |
| Dependency Change (`syncPassport`) | **83.273** | 81.374 | 102.005 | 15.332 | 18.8% | 31 | 90 | 46 | 57.6 | 2 |
| `where()` Symbol Lookup (Cold Cache) | **105.751** | 104.42 | 125.044 | 20.072 | 19.2% | 54 | 80 | 82 | 834.5 | 1 |
| `where()` Symbol Lookup (Warm Cache) | **12.26** | 12.633 | 15.576 | 1.856 | 14.7% | 54 | 80 | 3 | 37.3 | 0 |
| `search()` Keyword (In-Memory) | **0.244** | 0.274 | 0.46 | 0.098 | 36% | 0 | 0 | 0 | 0.0 | 0 |
| `hybridSearch()` (In-Memory + SQLite) | **1.435** | 1.686 | 3.074 | 0.71 | 42.1% | 0 | 0 | 0 | 0.0 | 0 |
| `contextHybrid()` (End-to-End w/ Disk Read) | **48.595** | 51.249 | 79.125 | 14.741 | 28.8% | 4 | 6 | 39 | 15.2 | 0 |

## 3. Memory Persistence Scaling (`agentRemember` on 80-File Project)

| Write Window | p50 (ms) | Mean (ms) | p95 (ms) | Dirs Walked / Write | Files Statted / Write | Files Read / Write | Bytes Read (KB) | Files Written / Write |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **First 5 Writes (N=1..5)** | **49.267** | 51.575 | 58.139 | 39 | 90 | 24 | 44.5 | 5 |
| **Last 5 Writes (N=26..30)** | **81.838** | 81.617 | 83.36 | 39 | 91 | 82 | 77.4 | 4 |

## 4. Retrieval Quality & Ablation Evaluation (`recall-eval-ds-v1`, 32 Queries)

| Retrieval Mode | Recall@1 | Recall@3 | Graded Rec@3 | Precision@1 | Precision@3 | MRR | nDCG@3 | nDCG@5 | Unnecessary@3 | Distractor Leaks | Avg Tokens | Latency (ms/q) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **KEYWORD_ONLY** | 90.6% | 96.9% | 88% | 96.9% | 53.1% | 0.938 | **0.934** | 0.942 | 46.9% | 12.5% | 203 | 12.451 |
| **FTS5_BM25_ONLY** | 90.6% | 96.9% | 86.5% | 100% | 51.6% | 0.938 | **0.933** | 0.946 | 48.4% | 0% | 235 | 0.217 |
| **VECTOR_ONLY** | 59.4% | 78.1% | 63% | 62.5% | 33.3% | 0.696 | **0.676** | 0.701 | 66.7% | 0% | 275 | 0.461 |
| **HYBRID_MINMAX** | 90.6% | 100% | 92.7% | 100% | 51.6% | 0.953 | **0.964** | 0.969 | 48.4% | 0% | 208 | 11.704 |
| **HYBRID_RRF** | 90.6% | 100% | 91.1% | 100% | 50.5% | 0.948 | **0.953** | 0.960 | 49.5% | 0% | 347 | 2.202 |
| **HYBRID_RAW** | 93.8% | 100% | 89.6% | 100% | 49.5% | 0.969 | **0.969** | 0.977 | 50.5% | 0% | 205 | 1.996 |

## 5. Symbol & File Lookup Evaluation (`whereIs`, 14 Ground-Truth Targets)

- **Recall@1**: `8/14 (57.1%)`
- **Recall@5**: `8/14 (57.1%)`
- **MRR**: `0.571`

### Missing Ground-Truth Symbol Categories (Baseline Gaps)
- **[unmodified-class-method]** query=`"revokeSessionSync"` $\rightarrow$ expected `src/auth/token-service.ts -> revokeSessionSync` (got: `No match`)
- **[exported-const]** query=`"DEFAULT_CLOCK_TOLERANCE_SEC"` $\rightarrow$ expected `src/auth/token-service.ts -> DEFAULT_CLOCK_TOLERANCE_SEC` (got: `No match`)
- **[unmodified-class-method]** query=`"commitTransactionSync"` $\rightarrow$ expected `src/db/ledger-repo.ts -> commitTransactionSync` (got: `No match`)
- **[exported-arrow-fn]** query=`"appendImmutableEntry"` $\rightarrow$ expected `src/db/ledger-repo.ts -> appendImmutableEntry` (got: `No match`)
- **[multi-word-query]** query=`"token service"` $\rightarrow$ expected `src/auth/token-service.ts -> AuthTokenService` (got: `No match`)
- **[multi-word-query]** query=`"verify bearer"` $\rightarrow$ expected `src/auth/token-service.ts -> verifyBearerToken` (got: `No match`)

## 6. Token Footprint (`costReport`)

- **Always-On Tokens**: `117` / `120` budget (`PASS`)
- **On-Demand Tokens**: `3953` across 5 files
