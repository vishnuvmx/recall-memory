---
id: mem_002
title: Non-volatile Passport and multi-model chat sync
type: decision
created: '2026-11-01'
updated: '2026-11-01'
tags:
  - architecture
  - multi-model
status: active
verification: unverified
confidence: 1
validFrom: '2026-11-01'
version: 1
tenantId: default
workspaceId: default
projectId: default
visibility: workspace
---

# Non-volatile Passport and multi-model chat sync

PASSPORT.md stores hash-fingerprinted non-volatile identity, commands, module exports, and active rules (without line numbers or timestamps), while chat-sync ingests lifecycle hook stdin/transcripts across Antigravity, Claude Code, and Cursor so normal chats update .recall/ without cold-run analysis.
