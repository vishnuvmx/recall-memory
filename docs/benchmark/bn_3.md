## B3 — Benchmark Execution Engine

Implement the benchmark runner against actual Recall production functions.

Measure:

- Initial indexing.
- Incremental indexing.
- Keyword retrieval.
- Vector retrieval.
- Hybrid retrieval.
- Symbol lookup.
- Context preparation.
- Memory persistence.

Record latency distributions, CPU time, memory usage, files inspected, bytes read, tokens produced and database operations where observable.

Implement warmup, repeated measurements, sequential execution and environment metadata collection.

Prevent dead-code elimination and ensure benchmark results are consumed.

Do not benchmark source-code functions through additional development-server overhead when the production build can be benchmarked directly.
