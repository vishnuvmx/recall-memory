import { agentState, type AgentState } from './agent.js';
import { recordCheckpoint, pruneSessions, type CheckpointOptions, type CheckpointResult } from './checkpoint.js';
import { loadConfig } from './config.js';
import { gitInfo, recallChanges, recallHistory, undoRecall, type Commit, type UndoResult } from './git.js';
import { indexState, rebuildIndex, type IndexState } from './index-builder.js';
import { generateProjectMap } from './mapper.js';
import { appendChangelog, createMemory, findMemory, loadAll, loadSearchableMemories, rewriteMemory, updateMemory, type Memory, type NewMemory } from './memory.js';
import { syncPassport, type PassportSyncResult } from './passport.js';
import { requireInitialized, type Project } from './project.js';
import { search, stem, tokenize, type SearchHit, type SearchOptions } from './retrieval.js';
import { hybridSearch, type FusionMode, type HybridSearchHit } from './hybrid-retrieval.js';
import { detectConflicts } from './conflict.js';
import { getSharedSqliteStore } from './sqlite-store.js';
import { where, type WhereHit } from './where.js';
import { PROFILE_BUDGETS, type ProfileTier, type WriteMode } from '../schemas/index.js';
import type { SecurityContext } from '../security/isolation.js';
import fs from 'node:fs';
import { resolveInside } from '../utils/fs.js';

export interface ContextOptions extends SearchOptions {
  hybrid?: boolean;
  securityContext?: SecurityContext;
  maxTokens?: number;
  maxChars?: number;
  includeSuperseded?: boolean;
  fusionMode?: FusionMode;
}

function refreshDerivedStores(p: Project, changedMemories?: Memory[]): void {
  const loaded = rebuildIndex(p.recallDir);
  const searchable = loadSearchableMemories(p.recallDir, loaded);
  try {
    const store = getSharedSqliteStore(p.recallDir);
    if (changedMemories && changedMemories.length > 0) {
      store.syncChangedMemories(changedMemories, searchable);
    } else {
      store.ensureSynced(searchable);
    }
  } catch {
    /* fallback cleanly when node:sqlite unavailable */
  }
  try {
    syncPassport(p.root, p.recallDir, { memories: searchable });
  } catch {
    /* non-fatal */
  }
}

/** Create a memory, log it, sync with SQLite, and refresh the index & passport. */
export function remember(start: string, input: NewMemory, action = 'remember'): Memory {
  const p = requireInitialized(start);
  const m = createMemory(p.recallDir, input);
  appendChangelog(p.recallDir, action, m);
  refreshDerivedStores(p, [m]);
  return m;
}

/** Agent-facing: always lands as `proposed` and is excluded from search until approved. */
export function propose(start: string, input: NewMemory): Memory {
  return remember(start, { ...input, status: 'proposed' }, 'propose');
}

const normTitle = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Exact normalized title match only (so fuzzy matches warn instead of silently overwriting). */
export function findDuplicate(candidates: Memory[], title: string): Memory | undefined {
  const n = normTitle(title);
  return candidates.find((m) => normTitle(m.title) === n);
}

export interface NearDuplicateHit {
  memory: Memory;
  similarity: number;
}

/**
 * Finds near-duplicate memories by stemmed title, tag, and body token overlap
 * without auto-merging them.
 */
export function findNearDuplicates(candidates: Memory[], input: NewMemory): NearDuplicateHit[] {
  const n = normTitle(input.title);
  const candTitleStems = new Set(tokenize(input.title).map(stem));
  const candTagStems = new Set((input.tags ?? []).flatMap((t) => tokenize(t)).map(stem));
  const candTopicStems = new Set([...candTitleStems, ...candTagStems]);
  const candBodyStems = new Set(tokenize(input.text).slice(0, 40).map(stem));

  if (candTopicStems.size === 0) return [];

  const hits: NearDuplicateHit[] = [];
  for (const m of candidates) {
    if (normTitle(m.title) === n) continue;

    const mTitleStems = new Set(tokenize(m.title).map(stem));
    const mTagStems = new Set(m.tags.flatMap((t) => tokenize(t)).map(stem));
    const mTopicStems = new Set([...mTitleStems, ...mTagStems]);
    const mBodyStems = new Set(tokenize(m.body).slice(0, 40).map(stem));

    if (mTopicStems.size === 0) continue;

    const topicInter = [...candTopicStems].filter((t) => mTopicStems.has(t)).length;
    const topicDice = (2 * topicInter) / (candTopicStems.size + mTopicStems.size);

    const bodyInter = [...candBodyStems].filter((t) => mBodyStems.has(t)).length;
    const bodyDice =
      candBodyStems.size > 0 && mBodyStems.size > 0
        ? (2 * bodyInter) / (candBodyStems.size + mBodyStems.size)
        : 0;

    const combinedSim = topicDice * 0.7 + bodyDice * 0.3;
    if (topicDice >= 0.55 || combinedSim >= 0.48) {
      hits.push({ memory: m, similarity: Math.round(Math.max(topicDice, combinedSim) * 100) / 100 });
    }
  }

  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, 3);
}

export interface RememberResult {
  memory: Memory;
  action: 'created' | 'updated';
  warnings?: string[];
}

/**
 * The write path for agents (CLI `remember` and MCP `recall_remember`).
 * - `writes: auto` (default): active immediately, so memory is useful without human ceremony.
 * - `writes: review` or RECALL_AGENT=1: lands as `proposed`.
 * An exact normalized title match updates the existing memory in place; fuzzy near-duplicates
 * and potential contradictions emit non-blocking `warnings` for review rather than silently
 * merging or superseding.
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
  const allMemories = loadAll(p.recallDir).memories;

  // In review mode never silently rewrite an approved memory; only merge into other proposals.
  const candidates = allMemories.filter(
    (m) => m.type === type && (status === 'active' ? m.status === 'active' || m.status === 'proposed' : m.status === 'proposed'),
  );
  const dup = findDuplicate(candidates, input.title);
  const warnings: string[] = [];

  if (!dup) {
    const nearDups = findNearDuplicates(
      allMemories.filter((m) => m.status === 'active' || m.status === 'proposed'),
      input,
    );
    for (const nd of nearDups) {
      warnings.push(
        `Possible duplicate of ${nd.memory.id} "${nd.memory.title}" (.recall/${nd.memory.file}, similarity: ${Math.round(nd.similarity * 100)}%) — consider merging or archiving.`,
      );
    }

    const conflict = detectConflicts(allMemories, input);
    if (conflict.hasConflict) {
      warnings.push(...conflict.warnings);
    }
  }

  const memory = dup
    ? rewriteMemory(p.recallDir, dup.id, { ...input, type, status })
    : createMemory(p.recallDir, { ...input, type, status }, allMemories);

  appendChangelog(p.recallDir, dup ? 'update' : 'remember', memory);
  refreshDerivedStores(p, [memory]);
  return {
    memory,
    action: dup ? 'updated' : 'created',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function whereIs(start: string, query: string, limit?: number): WhereHit[] {
  const p = requireInitialized(start);
  return where(p.root, p.recallDir, query, limit);
}

export function approve(start: string, id: string): Memory {
  const p = requireInitialized(start);
  const m = updateMemory(p.recallDir, id, { status: 'active', verification: 'verified' });
  appendChangelog(p.recallDir, 'approve', m);
  refreshDerivedStores(p, [m]);
  return m;
}

export function archive(start: string, id: string): Memory {
  const p = requireInitialized(start);
  const m = updateMemory(p.recallDir, id, { status: 'archived' });
  appendChangelog(p.recallDir, 'archive', m);
  refreshDerivedStores(p, [m]);
  return m;
}

export function contextHybrid(start: string, query: string, opts: ContextOptions = {}): HybridSearchHit[] {
  const p = requireInitialized(start);
  const all = loadSearchableMemories(p.recallDir);
  let store;
  try {
    store = getSharedSqliteStore(p.recallDir);
    store.ensureSynced(all);
  } catch {
    /* fallback cleanly when node:sqlite unavailable */
  }

  return hybridSearch(all, query, {
    limit: opts.limit,
    type: opts.type,
    tag: opts.tag,
    includeProposed: opts.includeProposed,
    includeArchived: opts.includeArchived,
    includeSuperseded: opts.includeSuperseded,
    minScore: opts.minScore,
    securityContext: opts.securityContext,
    sqliteStore: store,
    maxTokens: opts.maxTokens,
    maxChars: opts.maxChars,
    fusionMode: opts.fusionMode,
  });
}

export function context(start: string, query: string, opts: ContextOptions = {}): SearchHit[] {
  const p = requireInitialized(start);
  const isHybrid = opts.hybrid !== false;

  if (isHybrid) {
    const hits = contextHybrid(start, query, opts);
    return hits.map((h) => ({ memory: h.memory, score: h.score, excerpt: h.excerpt }));
  }

  const all = loadSearchableMemories(p.recallDir);
  return search(all, query, opts);
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
  const targets = ['PASSPORT.md', 'MEMORY.md', 'INDEX.md', 'PROJECT_MAP.md', 'CURRENT_STATE.md'];
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
    const updated = updateMemory(p.recallDir, m.id, { status: 'active', verification: 'verified' });
    appendChangelog(p.recallDir, 'approve', updated);
    approved.push(updated);
  }
  if (approved.length > 0) {
    refreshDerivedStores(p, approved);
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
    refreshDerivedStores(p, archived);
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

export function passport(start: string, opts?: { profile?: ProfileTier; force?: boolean }): PassportSyncResult {
  const p = requireInitialized(start);
  return syncPassport(p.root, p.recallDir, opts);
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
    refreshDerivedStores(p);
  }
  return res;
}
