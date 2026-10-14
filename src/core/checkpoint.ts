import fs from 'node:fs';
import path from 'node:path';
import { syncAntigravitySupport } from './agent.js';
import { repoChanges } from './git.js';
import { generateProjectMap } from './mapper.js';
import { atomicWrite, resolveInside, today } from '../utils/fs.js';

export interface CheckpointOptions {
  nextSteps?: string;
  clear?: boolean;
}

export interface CheckpointResult {
  timestamp: string;
  summary: string;
  nextSteps?: string;
  modifiedFiles: string[];
}

export function getCurrentTimestamp(): string {
  const d = new Date();
  return d.toISOString().replace('T', ' ').substring(0, 19);
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
  summary: string,
  opts: CheckpointOptions = {}
): CheckpointResult {
  const cleanSummary = opts.clear ? 'Previous task completed. Ready for new instructions.' : summary.trim();
  const timestamp = getCurrentTimestamp();
  const rawChanges = repoChanges(root) ?? [];
  const modifiedFiles = opts.clear ? [] : rawChanges.slice(0, 20); // Top 20 active files

  const result: CheckpointResult = {
    timestamp,
    summary: cleanSummary,
    nextSteps: opts.clear ? undefined : opts.nextSteps?.trim(),
    modifiedFiles,
  };

  const currentStateFile = resolveInside(recallDir, 'CURRENT_STATE.md');
  atomicWrite(currentStateFile, buildCurrentStateMarkdown(result));

  const sessionLogDir = path.join(recallDir, 'sessions');
  fs.mkdirSync(sessionLogDir, { recursive: true });
  const logFile = path.join(sessionLogDir, 'session-log.md');

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

  const existingLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trimEnd() : '# Session Log';
  atomicWrite(logFile, `${existingLog}\n\n${logEntry}`);

  // Automatically refresh project map and landmarks so line numbers never stay stale
  try {
    generateProjectMap(root, recallDir);
  } catch {
    // Non-fatal if project map regeneration encounters an error
  }

  // Keep Antigravity always_on rule warm with the latest checkpoint state
  try {
    syncAntigravitySupport(root, recallDir);
  } catch {
    // Non-fatal if Antigravity sync encounters an error
  }

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
