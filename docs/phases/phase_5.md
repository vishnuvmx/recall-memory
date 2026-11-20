# PHASE 5 — RECALL MEMORY INTELLIGENCE

Improve Recall's durable project knowledge system.

The goal is to remember useful technical knowledge, not duplicate the AI's conversation history.

Investigate local CPU-compatible libraries and models, including:

- Laya.
- FastEmbed.
- ONNX Runtime.
- Existing SQLite FTS5 retrieval.
- Existing vector retrieval.

Do not introduce all technologies automatically. Evaluate their actual value against the existing implementation.

Memory categories:

1. Architecture decisions.
2. Project conventions.
3. Design constraints.
4. Technical dependencies.
5. Known bugs.
6. Verified solutions.
7. Important implementation lessons.
8. Explicitly rejected approaches.

Memory operations should support:

- Classification.
- Importance estimation.
- Duplicate detection.
- Contradiction detection.
- Versioning.
- Expiration of temporary knowledge.
- Source provenance.
- Verification status.

Never allow a lightweight decision model to independently overwrite important project knowledge.

Use deterministic validation and preserve historical decisions.

Benchmark CPU performance, accuracy and memory overhead.

Do not introduce a large local language model unless justified by measured improvements.
