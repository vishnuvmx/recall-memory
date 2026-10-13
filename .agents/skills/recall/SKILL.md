---
name: recall
description: Project memory, codebase topology, and orientation protocol for multi-file tasks. Activate when navigating large files, querying architectural decisions, or checkpointing sessions.
---

# Recall Agent Protocol

This project uses Recall for persistent Git-versioned memory in `.recall/`.

## Orientation
1. Do NOT crawl directories recursively. Read `.recall/PROJECT_MAP.md` to find entry points, theme tokens, and symbol landmarks.
2. In files $\ge 300$ lines, use landmark lines as anchors ($\pm 50$ line window) to view target code directly.
3. For architectural constraints: run `recall context "<task>"` or call MCP `recall_context`.

## Recording State
1. Propose decisions/lessons: `recall propose "<text>" -t "<title>" --type <decision|lesson|convention>`.
2. Wrap-up checkpoint: `recall checkpoint "<summary>"` (or call MCP `recall_checkpoint`).
