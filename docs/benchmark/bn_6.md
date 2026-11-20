## B6 — Historical Benchmarking and Regression Detection

Implement versioned JSON benchmark reports.

Compare current results against an approved baseline using identical hardware, datasets and configuration.

Detect:

- Significant latency regressions.
- Increased memory consumption.
- Increased file scanning.
- Reduced retrieval accuracy.
- Increased context size.
- Incremental indexing regressions.

Use configurable thresholds and noise-aware comparisons.

Do not fail CI for insignificant timing fluctuations.

Generate a report explaining every regression and its measurement evidence.
