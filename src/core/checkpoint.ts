import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { repoChanges } from './git.js';
import { redactSecrets } from '../security/secrets.js';
import { atomicWrite, resolveInside, today } from '../utils/fs.js';

export interface CheckpointOptions {
  nextSteps?: string;
  clear?: boolean;
  auto?: boolean;
  retentionDays?: number;
  maxEntries?: number;
  model?: string;
  referencedFiles?: string[];
}

export interface CheckpointResult {
  timestamp: string;
  summary: string;
  nextSteps?: string;
  modifiedFiles: string[];
  referencedFiles?: string[];
  activeFileMap?: string[];
  model?: string;
  /** True when an auto checkpoint was skipped because nothing changed since the last one. */
  skipped?: boolean;
}

export interface SessionLogEntry {
  timestamp: string;
  date: Date;
  summary: string;
  nextSteps?: string;
  modifiedFiles?: string[];
  rawText: string;
}

export function getCurrentTimestamp(): string {
  const d = new Date();
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

export function parseSessionLogEntries(logContent: string): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  const lines = logContent.split('\n');
  let currentHeader: { timestamp: string; date: Date } | null = null;
  let currentLines: string[] = [];
  let summary = '';
  let nextSteps: string | undefined;
  let modifiedFiles: string[] | undefined;

  const flush = () => {
    if (currentHeader) {
      entries.push({
        timestamp: currentHeader.timestamp,
        date: currentHeader.date,
        summary: summary || 'Task checkpoint',
        nextSteps,
        modifiedFiles,
        rawText: currentLines.join('\n').trim(),
      });
    }
    currentHeader = null;
    currentLines = [];
    summary = '';
    nextSteps = undefined;
    modifiedFiles = undefined;
  };

  for (const line of lines) {
    const match = line.match(/^###\s*\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\]\s*Checkpoint/i);
    if (match) {
      flush();
      const ts = match[1]!;
      const parsedDate = new Date(ts.replace(' ', 'T') + 'Z');
      currentHeader = {
        timestamp: ts,
        date: isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
      };
      currentLines.push(line);
      continue;
    }

    if (currentHeader) {
      currentLines.push(line);
      const summaryMatch = line.match(/^-\s*\*\*Summary\*\*:\s*(.*)$/i);
      if (summaryMatch) {
        summary = summaryMatch[1]!.trim();
      }
      const nextMatch = line.match(/^-\s*\*\*Next\*\*:\s*(.*)$/i);
      if (nextMatch) {
        nextSteps = nextMatch[1]!.trim();
      }
      const modMatch = line.match(/^-\s*\*\*Modified\*\*:\s*(.*)$/i);
      if (modMatch) {
        modifiedFiles = modMatch[1]!.split(',').map((f) => f.trim()).filter(Boolean);
      }
    }
  }
  flush();

  return entries;
}

export interface PruneOptions {
  retentionDays?: number;
  maxEntries?: number;
  now?: Date;
}

export function pruneSessionLog(
  logContent: string,
  opts: PruneOptions = {}
): { content: string; retained: SessionLogEntry[]; removedCount: number } {
  const retentionDays = opts.retentionDays ?? 14;
  const maxEntries = opts.maxEntries ?? 50;
  const now = opts.now ?? new Date();
  const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const entries = parseSessionLogEntries(logContent);
  if (entries.length === 0) {
    return {
      content: logContent.trim() ? logContent.trim() : '# Session Log',
      retained: [],
      removedCount: 0,
    };
  }

  // Filter out entries older than retention cutoff (e.g. 14 days)
  let retained = entries.filter((e) => e.date.getTime() >= cutoffTime);

  // If total entries still exceed maxEntries, keep only the newest ones
  if (retained.length > maxEntries) {
    retained = retained.slice(-maxEntries);
  }

  const removedCount = entries.length - retained.length;
  const header = '# Session Log';
  const body = retained.map((e) => e.rawText).join('\n\n');
  const content = body ? `${header}\n\n${body}\n` : `${header}\n`;

  return {
    content,
    retained,
    removedCount,
  };
}

export function pruneSessions(
  recallDir: string,
  opts: PruneOptions = {}
): { removedCount: number; remainingCount: number } {
  const logFile = path.join(recallDir, 'sessions', 'session-log.md');
  if (!fs.existsSync(logFile)) {
    return { removedCount: 0, remainingCount: 0 };
  }
  let retentionDays = 14;
  let maxEntries = 50;
  try {
    const cfg = loadConfig(recallDir);
    if (cfg.retentionDays) retentionDays = cfg.retentionDays;
    if (cfg.maxLogEntries) maxEntries = cfg.maxLogEntries;
  } catch {
    // Non-fatal fallback to defaults
  }
  if (opts.retentionDays !== undefined) retentionDays = opts.retentionDays;
  if (opts.maxEntries !== undefined) maxEntries = opts.maxEntries;

  const raw = fs.readFileSync(logFile, 'utf8');
  const res = pruneSessionLog(raw, { retentionDays, maxEntries, now: opts.now });
  atomicWrite(logFile, res.content);
  return { removedCount: res.removedCount, remainingCount: res.retained.length };
}

import * as fsNode from 'node:fs';
import * as pathNode from 'node:path';

const CODE_FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cs|rb|php)$/i;
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'delete', 'await', 'yield']);

export function buildActiveFileSymbolMap(root: string, files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const rootAbs = pathNode.resolve(root);

  for (const rawFile of files) {
    const rel = rawFile.replace(/\\/g, '/').trim();
    if (!rel || seen.has(rel) || !CODE_FILE_EXT_RE.test(rel)) continue;
    seen.add(rel);

    const abs = pathNode.resolve(rootAbs, rel);
    if (!abs.startsWith(rootAbs + pathNode.sep) && abs !== rootAbs) continue;
    let content: string;
    try {
      const stat = fsNode.statSync(abs);
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      content = fsNode.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const symbols: Array<{ name: string; line: number }> = [];
    const seenSyms = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m =
        line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/) ??
        line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/) ??
        line.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/) ??
        line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/) ??
        line.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\{\s*$/) ??
        line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/) ??
        line.match(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/) ??
        line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);

      if (m && m[1] && !CONTROL_KEYWORDS.has(m[1]) && !seenSyms.has(m[1])) {
        seenSyms.add(m[1]);
        symbols.push({ name: m[1], line: i + 1 });
        if (symbols.length >= 12) break;
      }
    }

    if (symbols.length > 0) {
      const symText = symbols.map((s) => `\`${s.name}\` (:${s.line})`).join(', ');
      out.push(`- \`${rel}\` (${lines.length} lines): ${symText}`);
    } else {
      out.push(`- \`${rel}\` (${lines.length} lines)`);
    }
    if (out.length >= 8) break;
  }

  return out;
}

export function buildCurrentStateMarkdown(result: CheckpointResult): string {
  const lines: string[] = [
    '# Previous Iteration State (Historical Context Only)',
    '',
    `> **Last Updated**: ${result.timestamp}${result.model ? ` · **Model**: ${result.model}` : ''}`,
    '> **AI AGENTS**: This records what happened in the PREVIOUS session. DO NOT execute these files or next steps unless the user explicitly asks to continue that specific work. Always prioritize the user\'s current prompt.',
    '',
    '## Previous Progress',
    result.summary,
    '',
  ];

  if (result.nextSteps) {
    lines.push('## Previous Task Next Steps (Conditional on User Request)', result.nextSteps, '');
  }

  if (result.activeFileMap && result.activeFileMap.length > 0) {
    lines.push('## Active Working Files & Symbol Map (Skip File Discovery)');
    for (const entry of result.activeFileMap) {
      lines.push(entry);
    }
    lines.push('');
  }

  lines.push('## Files Modified in Previous Task');
  if (result.modifiedFiles.length === 0) {
    lines.push('_Working directory clean or no uncommitted changes._');
  } else {
    for (const file of result.modifiedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  if (result.referencedFiles && result.referencedFiles.length > 0) {
    lines.push('', '## Files Discussed / Referenced in Chat');
    for (const file of result.referencedFiles.slice(0, 10)) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push('');

  return lines.join('\n');
}

export function recordCheckpoint(
  root: string,
  recallDir: string,
  summary?: string,
  opts: CheckpointOptions = {}
): CheckpointResult {
  const rawChanges = repoChanges(root) ?? [];
  const modifiedFiles = opts.clear ? [] : rawChanges.slice(0, 20); // Top 20 active files

  let cleanSummary = summary?.trim();
  if (opts.clear) {
    cleanSummary = 'Previous task completed. Ready for new instructions.';
  } else if (!cleanSummary || cleanSummary === 'Task checkpoint') {
    if (modifiedFiles.length > 0) {
      const sample = modifiedFiles.slice(0, 3).join(', ');
      const extra = modifiedFiles.length > 3 ? ` (+${modifiedFiles.length - 3} more)` : '';
      cleanSummary = `Session update: modified ${sample}${extra}`;
    } else {
      cleanSummary = 'Session chat iteration completed (working directory clean)';
    }
  }

  cleanSummary = redactSecrets(cleanSummary).redacted;
  const safeNextSteps = opts.clear || !opts.nextSteps?.trim()
    ? undefined
    : redactSecrets(opts.nextSteps.trim()).redacted;

  const timestamp = getCurrentTimestamp();

  const sessionLogDir = path.join(recallDir, 'sessions');
  const logFile = path.join(sessionLogDir, 'session-log.md');
  const existingRaw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  // The Stop hook fires after every agent turn; don't log a duplicate entry when summary + files match.
  if (opts.auto && !opts.clear) {
    const last = parseSessionLogEntries(existingRaw).at(-1);
    const lastFiles = last?.modifiedFiles ?? [];
    const sameFiles = lastFiles.length === modifiedFiles.length && lastFiles.every((f, i) => f === modifiedFiles[i]);
    const sameSummary = last?.summary === cleanSummary || (!summary?.trim() && last?.summary.startsWith('Session '));
    if (last && sameFiles && sameSummary) {
      return { timestamp: last.timestamp, summary: last.summary, modifiedFiles, skipped: true };
    }
  }

  const referenced = (opts.referencedFiles ?? []).filter((f) => !modifiedFiles.includes(f)).slice(0, 10);
  const activeFileMap = buildActiveFileSymbolMap(root, [...modifiedFiles, ...referenced]);

  const result: CheckpointResult = {
    timestamp,
    summary: cleanSummary,
    nextSteps: safeNextSteps,
    modifiedFiles,
    ...(referenced.length > 0 ? { referencedFiles: referenced } : {}),
    ...(activeFileMap.length > 0 ? { activeFileMap } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };

  const currentStateFile = resolveInside(recallDir, 'CURRENT_STATE.md');
  atomicWrite(currentStateFile, buildCurrentStateMarkdown(result));

  fs.mkdirSync(sessionLogDir, { recursive: true });

  const entryLines: string[] = [
    `### [${timestamp}] Checkpoint`,
    `- **Summary**: ${cleanSummary}`,
  ];
  if (opts.model) {
    entryLines.push(`- **Model**: ${opts.model}`);
  }
  if (result.nextSteps) {
    entryLines.push(`- **Next**: ${result.nextSteps}`);
  }
  if (modifiedFiles.length > 0) {
    entryLines.push(`- **Modified**: ${modifiedFiles.join(', ')}`);
  } else if (referenced.length > 0) {
    entryLines.push(`- **Referenced**: ${referenced.join(', ')}`);
  }
  const logEntry = `${entryLines.join('\n')}\n\n`;

  let retentionDays = 14;
  let maxEntries = 50;
  try {
    const cfg = loadConfig(recallDir);
    if (cfg.retentionDays) retentionDays = cfg.retentionDays;
    if (cfg.maxLogEntries) maxEntries = cfg.maxLogEntries;
  } catch {
    // Non-fatal if config missing or uninitialized
  }
  if (opts.retentionDays !== undefined) retentionDays = opts.retentionDays;
  if (opts.maxEntries !== undefined) maxEntries = opts.maxEntries;

  const existingLog = existingRaw ? existingRaw.trimEnd() : '# Session Log';
  const combinedLog = `${existingLog}\n\n${logEntry}`;
  const pruned = pruneSessionLog(combinedLog, { retentionDays, maxEntries });
  atomicWrite(logFile, pruned.content);

  // Deliberately no agent-file or project-map rewrites here: checkpoints run from a hook after every
  // session, and mutating always-on agent instructions would invalidate provider prompt caches.
  return result;
}

export function initialCurrentStateMarkdown(): string {
  return [
    '# Project State (Ready)',
    '',
    `> **Initialized**: ${today()}`,
    '> **AI AGENTS**: Project initialized. Always prioritize the user\'s immediate prompt.',
    '',
    '## Status',
    'Ready for tasks. No previous work in progress.',
    '',
  ].join('\n');
}
