#!/usr/bin/env node
/**
 * Local incremental Recall synchronizer & live chat/workspace watcher.
 *
 * Usage:
 *   node scripts/recall-sync.js                              # One-shot incremental sync (0 re-analysis if unchanged)
 *   node scripts/recall-sync.js --all-agents                 # Sync instructions & hooks for all AI models/IDEs
 *   node scripts/recall-sync.js --transcript <chat.jsonl>    # Ingest local AI chat transcript & update .recall/
 *   node scripts/recall-sync.js --note "Decision: ..."       # Record chat note/decision locally & refresh PASSPORT.md
 *   node scripts/recall-sync.js --watch [--transcript <p>]   # Watch workspace & chat transcript in real time
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncWorkspace } from '../dist/index.js';

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArg = (f) => {
  const idx = args.indexOf(f);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
};

const targetDir = getArg('--cwd') ? path.resolve(getArg('--cwd')) : process.cwd();
const transcriptPath = getArg('--transcript') ? path.resolve(getArg('--transcript')) : undefined;
const note = getArg('--note');
const model = getArg('--model');
const force = hasFlag('--force') || hasFlag('-f');
const allAgents = hasFlag('--all-agents');
const watchMode = hasFlag('--watch') || hasFlag('-w');

function runOnce(reason = 'manual') {
  const t0 = performance.now();
  const rep = syncWorkspace(targetDir, {
    force: reason === 'manual' ? force : false,
    transcriptPath,
    note: reason === 'manual' ? note : undefined,
    model,
    allAgents: reason === 'manual' ? allAgents : false,
  });
  const ms = (performance.now() - t0).toFixed(1);

  const changes = [];
  if (rep.passportUpdated) changes.push('PASSPORT.md');
  if (rep.mapUpdated) changes.push('PROJECT_MAP.md');
  if (rep.indexRebuilt) changes.push('INDEX.md');
  if (rep.sqliteSynced) changes.push('recall.db');
  if (rep.chatCheckpointRecorded) changes.push('CURRENT_STATE.md');
  if (rep.insightsSaved.length > 0) {
    changes.push(`${rep.insightsSaved.length} insight(s)`);
  }

  if (changes.length > 0 || reason === 'manual') {
    const status = changes.length > 0 ? `updated [${changes.join(', ')}]` : 'up to date (0 cold re-analysis)';
    console.log(`[recall-sync] (${ms} ms) ${status}`);
    for (const ins of rep.insightsSaved) {
      console.log(`  + [${ins.type}] ${ins.id}: ${ins.title} (${ins.action})`);
    }
  }
}

runOnce('manual');

if (watchMode) {
  console.log(`[recall-sync] Watching ${targetDir}${transcriptPath ? ` + transcript ${transcriptPath}` : ''} for local changes... (Ctrl+C to stop)`);
  let timer = null;
  let isSyncing = false;

  const scheduleSync = (source) => {
    if (isSyncing) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      isSyncing = true;
      try {
        runOnce(source);
      } catch (err) {
        console.error(`[recall-sync] warning: ${err.message}`);
      } finally {
        isSyncing = false;
      }
    }, 600);
  };

  const ignoredSegments = new Set(['.git', 'node_modules', 'dist', '.cache', 'sessions', 'logs']);

  try {
    fs.watch(targetDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const norm = filename.replace(/\\/g, '/');
      const parts = norm.split('/');
      if (parts.some((p) => ignoredSegments.has(p))) return;
      if (norm === '.recall/PASSPORT.md' || norm === '.recall/PROJECT_MAP.md' || norm === '.recall/INDEX.md' || norm === '.recall/CURRENT_STATE.md') {
        return; // ignore our own derived outputs to avoid feedback loops
      }
      scheduleSync(`fs:${norm}`);
    });
  } catch (err) {
    console.error(`[recall-sync] Recursive watch fallback: ${err.message}`);
  }

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    fs.watchFile(transcriptPath, { interval: 1000 }, () => {
      scheduleSync('transcript');
    });
  }
}

