import fs from 'node:fs';
import { resolveInside } from '../utils/fs.js';
import { atomicWrite } from '../utils/fs.js';
import { applyManagedBlock, extractManagedBlock } from '../utils/managed.js';
import { loadAll, type LoadResult } from './memory.js';
import type { MemoryType } from '../schemas/index.js';

const SECTIONS: Array<[MemoryType, string]> = [
  ['decision', 'Decisions'],
  ['convention', 'Conventions'],
  ['design_system', 'Design system'],
  ['fact', 'Facts'],
  ['lesson', 'Lessons'],
  ['bugfix', 'Bugfixes'],
  ['failed_approach', 'Failed approaches'],
  ['task', 'Tasks'],
];
const NAME = 'recall:index';
const esc = (s: string): string => s.replace(/([[\]])/g, '\\$1');

/** Deterministic: depends only on memory metadata, sorted by id. */
export function buildIndexBlock(loaded: LoadResult): string {
  const out: string[] = [];
  const active = loaded.memories.filter((m) => m.status === 'active');
  for (const [type, heading] of SECTIONS) {
    const items = active.filter((m) => m.type === type);
    if (items.length === 0) continue;
    out.push(`## ${heading}`, ...items.map((m) => `- [${esc(m.title)}](${m.file})`), '');
  }
  if (loaded.plainDocs.length > 0) {
    out.push('## Rule documents', ...[...loaded.plainDocs].sort().map((f) => `- [${f.replace(/^rules\//, '')}](${f})`), '');
  }
  const proposed = loaded.memories.filter((m) => m.status === 'proposed');
  if (proposed.length > 0) {
    out.push('## Proposed (awaiting `recall approve`)', ...proposed.map((m) => `- [${esc(m.title)}](${m.file}) (${m.id})`), '');
  }
  if (out.length === 0) out.push('_No memories yet. Use `recall remember` to add one._', '');
  return out.join('\n').trimEnd();
}

export function indexPath(recallDir: string): string {
  return resolveInside(recallDir, 'INDEX.md');
}

export function renderIndex(existing: string, loaded: LoadResult): string {
  const base = existing.trim() === '' ? '# Recall Memory Index\n' : existing;
  return applyManagedBlock(base, buildIndexBlock(loaded), NAME);
}

/** Rebuild INDEX.md; text outside the managed block is preserved. */
export function rebuildIndex(recallDir: string): LoadResult {
  const loaded = loadAll(recallDir);
  const file = indexPath(recallDir);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  atomicWrite(file, renderIndex(existing, loaded));
  return loaded;
}

export type IndexState = 'missing' | 'up_to_date' | 'stale' | 'no_managed_block';

export function indexState(recallDir: string): IndexState {
  const file = indexPath(recallDir);
  if (!fs.existsSync(file)) return 'missing';
  const existing = fs.readFileSync(file, 'utf8');
  const block = extractManagedBlock(existing, NAME);
  if (block === null) return 'no_managed_block';
  return block === buildIndexBlock(loadAll(recallDir)).trim() ? 'up_to_date' : 'stale';
}

/** Relative link targets in INDEX.md that do not exist. */
export function brokenIndexLinks(recallDir: string): string[] {
  const file = indexPath(recallDir);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const broken: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    const target = m[1]!;
    if (/^[a-z]+:/i.test(target)) continue;
    try {
      if (!fs.existsSync(resolveInside(recallDir, target))) broken.push(target);
    } catch {
      broken.push(target);
    }
  }
  return [...new Set(broken)];
}
