import { agentState, type AgentState } from './agent.js';
import { recordCheckpoint, pruneSessions, type CheckpointOptions, type CheckpointResult } from './checkpoint.js';
import { loadConfig } from './config.js';
import { gitInfo, recallChanges, recallHistory, undoRecall, type Commit, type UndoResult } from './git.js';
import { indexState, rebuildIndex, type IndexState } from './index-builder.js';
import { generateProjectMap } from './mapper.js';
import { appendChangelog, createMemory, loadAll, rewriteMemory, updateMemory, type Memory, type NewMemory } from './memory.js';
import { requireInitialized, type Project } from './project.js';
import { search, tokenize, type SearchHit, type SearchOptions } from './retrieval.js';
import { where, type WhereHit } from './where.js';
import { PROFILE_BUDGETS, type ProfileTier, type WriteMode } from '../schemas/index.js';
import fs from 'node:fs';
import { resolveInside } from '../utils/fs.js';

/** Create a memory, log it, and refresh the index. */
export function remember(start: string, input: NewMemory, action = 'remember'): Memory {
  const p = requireInitialized(start);
  const m = createMemory(p.recallDir, input);
  appendChangelog(p.recallDir, action, m);
  rebuildIndex(p.recallDir);
  return m;
}

/** Agent-facing: always lands as `proposed` and is excluded from search until approved. */
export function propose(start: string, input: NewMemory): Memory {
  return remember(start, { ...input, status: 'proposed' }, 'propose');
}

const normTitle = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Same normalized title, or high word overlap (Jaccard >= 0.7 over >= 2 words each). */
export function findDuplicate(candidates: Memory[], title: string): Memory | undefined {
  const n = normTitle(title);
  const exact = candidates.find((m) => normTitle(m.title) === n);
  if (exact) return exact;
  const a = new Set(tokenize(title));
  if (a.size < 2) return undefined;
  let best: { m: Memory; j: number } | undefined;
  for (const m of candidates) {
    const b = new Set(tokenize(m.title));
    if (b.size < 2) continue;
    const inter = [...a].filter((t) => b.has(t)).length;
    const j = inter / (a.size + b.size - inter);
    if (j >= 0.7 && (!best || j > best.j)) best = { m, j };
  }
  return best?.m;
}

export interface RememberResult {
  memory: Memory;
  action: 'created' | 'updated';
}

/**
 * The write path for agents (CLI `remember` and MCP `recall_remember`).
 * - `writes: auto` (default): active immediately, so memory is useful without human ceremony.
 * - `writes: review` or RECALL_AGENT=1: lands as `proposed`.
 * A near-duplicate title updates the existing memory instead of adding another file, which keeps
 * retrieval results (and their token cost) from growing with repetition.
 */
export function agentRemember(start: string, input: NewMemory): RememberResult {
  const p = requireInitialized(start);
  let mode: WriteMode = 'auto';
  try {
    mode = loadConfig(p.recallDir).writes;
  } catch {
    /* surfaced by `recall doctor` */
  }
  const status = input.status ?? (mode === 'review' || process.env.RECALL_AGENT === '1' ? 'proposed' : 'active');
  const type = input.type ?? 'fact';
  // In review mode never silently rewrite an approved memory; only merge into other proposals.
  const candidates = loadAll(p.recallDir).memories.filter(
    (m) => m.type === type && (status === 'active' ? m.status === 'active' || m.status === 'proposed' : m.status === 'proposed'),
  );
  const dup = findDuplicate(candidates, input.title);
  const memory = dup
    ? rewriteMemory(p.recallDir, dup.id, { ...input, type, status })
    : createMemory(p.recallDir, { ...input, type, status });
  appendChangelog(p.recallDir, dup ? 'update' : 'remember', memory);
  rebuildIndex(p.recallDir);
  return { memory, action: dup ? 'updated' : 'created' };
}

export function whereIs(start: string, query: string, limit?: number): WhereHit[] {
  const p = requireInitialized(start);
  return where(p.root, p.recallDir, query, limit);
}

export function approve(start: string, id: string): Memory {
  const p = requireInitialized(start);
  const m = updateMemory(p.recallDir, id, { status: 'active' });
  appendChangelog(p.recallDir, 'approve', m);
  rebuildIndex(p.recallDir);
  return m;
}

export function archive(start: string, id: string): Memory {
  const p = requireInitialized(start);
  const m = updateMemory(p.recallDir, id, { status: 'archived' });
  appendChangelog(p.recallDir, 'archive', m);
  rebuildIndex(p.recallDir);
  return m;
}

export function context(start: string, query: string, opts: SearchOptions): SearchHit[] {
  const p = requireInitialized(start);
  return search(loadAll(p.recallDir).memories, query, opts);
}

export interface TokenFootprint {
  totalTokens: number;
  budgetTokens: number;
  profile: ProfileTier;
  files: Record<string, number>;
}

export interface StatusReport {
  project: Project;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  problems: number;
  index: IndexState;
  agentFile: string;
  agent: AgentState | 'unknown';
  git: { available: boolean; isRepo: boolean; changes: string[] | null };
  tokens: TokenFootprint;
  profile: ProfileTier;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function computeTokenFootprint(recallDir: string, profile: ProfileTier = 'standard'): TokenFootprint {
  const targets = ['MEMORY.md', 'INDEX.md', 'PROJECT_MAP.md', 'CURRENT_STATE.md'];
  const files: Record<string, number> = {};
  let totalChars = 0;

  for (const f of targets) {
    const p = resolveInside(recallDir, f);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        const tok = estimateTokens(content.length);
        files[f] = tok;
        totalChars += content.length;
      } catch {
        files[f] = 0;
      }
    } else {
      files[f] = 0;
    }
  }

  return {
    totalTokens: estimateTokens(totalChars),
    budgetTokens: PROFILE_BUDGETS[profile],
    profile,
    files,
  };
}

export function status(start: string): StatusReport {
  const p = requireInitialized(start);
  const loaded = loadAll(p.recallDir);
  const count = (key: 'type' | 'status'): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const m of loaded.memories) out[m[key]] = (out[m[key]] ?? 0) + 1;
    return out;
  };
  let agentFile = 'AGENTS.md';
  let agent: StatusReport['agent'] = 'unknown';
  let profile: ProfileTier = 'standard';
  try {
    const cfg = loadConfig(p.recallDir);
    agentFile = cfg.agentFile;
    profile = cfg.profile ?? 'standard';
    agent = agentState(p.root, agentFile);
  } catch {
    /* surfaced by `recall doctor` */
  }
  const g = gitInfo(p.root);
  return {
    project: p,
    byType: count('type'),
    byStatus: count('status'),
    problems: loaded.problems.length,
    index: indexState(p.recallDir),
    agentFile,
    agent,
    git: { ...g, changes: g.isRepo ? recallChanges(p.root) : null },
    tokens: computeTokenFootprint(p.recallDir, profile),
    profile,
  };
}

export function getProposals(start: string): Memory[] {
  const p = requireInitialized(start);
  return loadAll(p.recallDir).memories.filter((m) => m.status === 'proposed');
}

export function approveAll(start: string): Memory[] {
  const p = requireInitialized(start);
  const proposals = getProposals(start);
  const approved: Memory[] = [];
  for (const m of proposals) {
    const updated = updateMemory(p.recallDir, m.id, { status: 'active' });
    appendChangelog(p.recallDir, 'approve', updated);
    approved.push(updated);
  }
  if (approved.length > 0) {
    rebuildIndex(p.recallDir);
  }
  return approved;
}

export function archiveAll(start: string): Memory[] {
  const p = requireInitialized(start);
  const proposals = getProposals(start);
  const archived: Memory[] = [];
  for (const m of proposals) {
    const updated = updateMemory(p.recallDir, m.id, { status: 'archived' });
    appendChangelog(p.recallDir, 'archive', updated);
    archived.push(updated);
  }
  if (archived.length > 0) {
    rebuildIndex(p.recallDir);
  }
  return archived;
}

export interface LogReport {
  source: 'git' | 'changelog';
  committed: Commit[];
  uncommitted: string[];
  changelog: string[];
}

export function log(start: string, limit: number): LogReport {
  const p = requireInitialized(start);
  const g = gitInfo(p.root);
  if (g.isRepo) {
    const committed = recallHistory(p.root, limit);
    if (committed) {
      return { source: 'git', committed, uncommitted: recallChanges(p.root) ?? [], changelog: [] };
    }
  }
  const file = resolveInside(p.recallDir, 'logs', 'CHANGELOG.md');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- ')) : [];
  return { source: 'changelog', committed: [], uncommitted: [], changelog: lines.slice(-limit).reverse() };
}

export function map(start: string, profile?: ProfileTier): string {
  const p = requireInitialized(start);
  return generateProjectMap(p.root, p.recallDir, profile);
}

export function checkpoint(start: string, summary?: string, opts?: CheckpointOptions): CheckpointResult {
  const p = requireInitialized(start);
  return recordCheckpoint(p.root, p.recallDir, summary, opts);
}

export function prune(start: string, opts?: { retentionDays?: number; maxEntries?: number }): { removedCount: number; remainingCount: number } {
  const p = requireInitialized(start);
  return pruneSessions(p.recallDir, opts);
}

export function undo(start: string, opts?: { dryRun?: boolean }): UndoResult {
  const p = requireInitialized(start);
  const res = undoRecall(p.root, '.recall', opts);
  if (!opts?.dryRun && res.ok && fs.existsSync(p.recallDir)) {
    rebuildIndex(p.recallDir);
  }
  return res;
}
