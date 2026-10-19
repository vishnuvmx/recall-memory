import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { repoChanges } from './git.js';
import { atomicWrite, resolveInside, today } from '../utils/fs.js';

export interface CheckpointOptions {
  nextSteps?: string;
  clear?: boolean;
  auto?: boolean;
  retentionDays?: number;
  maxEntries?: number;
}

export interface CheckpointResult {
  timestamp: string;
  summary: string;
  nextSteps?: string;
  modifiedFiles: string[];
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

export function buildCurrentStateMarkdown(result: CheckpointResult): string {
  const lines: string[] = [
    '# Previous Iteration State (Historical Context Only)',
    '',
    `> **Last Updated**: ${result.timestamp}`,
    '> **AI AGENTS**: This records what happened in the PREVIOUS session. DO NOT execute these files or next steps unless the user explicitly asks to continue that specific work. Always prioritize the user\'s current prompt.',
    '',
    '## Previous Progress',
    result.summary,
    '',
  ];

  if (result.nextSteps) {
    lines.push('## Previous Task Next Steps (Conditional on User Request)', result.nextSteps, '');
  }

  lines.push('## Files Modified in Previous Task');
  if (result.modifiedFiles.length === 0) {
    lines.push('_Working directory clean or no uncommitted changes._');
  } else {
    for (const file of result.modifiedFiles) {
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
  } else if (!cleanSummary || cleanSummary === 'Task checkpoint' || opts.auto) {
    if (modifiedFiles.length > 0) {
      const sample = modifiedFiles.slice(0, 3).join(', ');
      const extra = modifiedFiles.length > 3 ? ` (+${modifiedFiles.length - 3} more)` : '';
      cleanSummary = `Session update: modified ${sample}${extra}`;
    } else {
      cleanSummary = 'Session chat iteration completed (working directory clean)';
    }
  }

  const timestamp = getCurrentTimestamp();

  const sessionLogDir = path.join(recallDir, 'sessions');
  const logFile = path.join(sessionLogDir, 'session-log.md');
  const existingRaw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

  // The Stop hook fires after every agent turn; don't log a new entry when nothing changed.
  if (opts.auto && !opts.clear) {
    const last = parseSessionLogEntries(existingRaw).at(-1);
    const lastFiles = last?.modifiedFiles ?? [];
    const same = lastFiles.length === modifiedFiles.length && lastFiles.every((f, i) => f === modifiedFiles[i]);
    if (last && same && last.summary.startsWith('Session ')) {
      return { timestamp: last.timestamp, summary: last.summary, modifiedFiles, skipped: true };
    }
  }

  const result: CheckpointResult = {
    timestamp,
    summary: cleanSummary,
    nextSteps: opts.clear ? undefined : opts.nextSteps?.trim(),
    modifiedFiles,
  };

  const currentStateFile = resolveInside(recallDir, 'CURRENT_STATE.md');
  atomicWrite(currentStateFile, buildCurrentStateMarkdown(result));

  fs.mkdirSync(sessionLogDir, { recursive: true });

  const entryLines: string[] = [
    `### [${timestamp}] Checkpoint`,
    `- **Summary**: ${cleanSummary}`,
  ];
  if (result.nextSteps) {
    entryLines.push(`- **Next**: ${result.nextSteps}`);
  }
  if (modifiedFiles.length > 0) {
    entryLines.push(`- **Modified**: ${modifiedFiles.join(', ')}`);
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
