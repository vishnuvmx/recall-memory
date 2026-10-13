---
id: mem_001
title: Local-first Git architecture
type: decision
created: '2026-10-11'
updated: '2026-10-11'
tags:
  - architecture
  - git
  - offline
status: active
verification: verified
sources:
  - docs/ARCHITECTURE.md
---

# Local-first Git architecture

Recall operates 100% locally with zero external network or telemetry calls. All persistent memory is stored as human-reviewable Markdown files inside .recall/ and tracked via Git.
