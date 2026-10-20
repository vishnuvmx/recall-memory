import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  memoryMetaSchema,
  type Lifecycle,
  type MemoryMeta,
  type MemoryType,
  type Verification,
} from '../schemas/index.js';
import { RecallError, atomicWrite, resolveInside, toPosix, today } from '../utils/fs.js';
import { assertNoSecrets } from '../utils/secrets.js';
import { assertNotPoisoned } from '../security/poisoning.js';
import type { Visibility } from '../schemas/index.js';

export interface Memory extends MemoryMeta {
  body: string;
  /** Path relative to the .recall directory, POSIX separators. */
  file: string;
}

export interface Problem {
  file: string;
  error: string;
}

export interface LoadResult {
  memories: Memory[];
  /** Plain Markdown docs in rules/ with no frontmatter (hand-written rules). */
  plainDocs: string[];
  problems: Problem[];
}

export const TYPE_DIR: Record<MemoryType, string> = {
  decision: 'decisions',
  lesson: 'lessons',
  bugfix: 'lessons',
  failed_approach: 'lessons',
  task: 'tasks',
  fact: 'rules',
  convention: 'rules',
  design_system: 'rules',
};
export const MEMORY_DIRS = ['rules', 'decisions', 'lessons', 'tasks'] as const;

export function slugify(title: string): string {
  const s = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'memory';
}

/** Only regular .md files directly in a memory dir; symlinks are never followed. */
function listMarkdown(recallDir: string, dir: string): string[] {
  const abs = path.join(recallDir, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.isSymbolicLink() && d.name.toLowerCase().endsWith('.md'))
    .map((d) => d.name)
    .sort();
}

export function loadAll(recallDir: string): LoadResult {
  const result: LoadResult = { memories: [], plainDocs: [], problems: [] };
  const todayStr = today();
  for (const dir of MEMORY_DIRS) {
    for (const name of listMarkdown(recallDir, dir)) {
      const rel = `${dir}/${name}`;
      let raw: string;
      try {
        raw = fs.readFileSync(resolveInside(recallDir, dir, name), 'utf8');
      } catch (err) {
        result.problems.push({ file: rel, error: (err as Error).message });
        continue;
      }
      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(raw);
      } catch (err) {
        result.problems.push({ file: rel, error: `Invalid frontmatter YAML: ${(err as Error).message.split('\n')[0]}` });
        continue;
      }
      if (Object.keys(parsed.data).length === 0) {
        if (dir === 'rules') result.plainDocs.push(rel);
        else result.problems.push({ file: rel, error: 'Missing frontmatter.' });
        continue;
      }
      const meta = memoryMetaSchema.safeParse(parsed.data);
      if (!meta.success) {
        const msg = meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        result.problems.push({ file: rel, error: `Invalid metadata: ${msg}` });
        continue;
      }
      const data = meta.data;
      // Auto-deprecate expired memories so outdated instructions do not compete with current ones
      if (data.expiresAt && data.expiresAt < todayStr && data.status === 'active') {
        data.status = 'superseded';
        data.deprecated = true;
        data.deprecatedReason = data.deprecatedReason || `Expired on ${data.expiresAt}`;
      }
      result.memories.push({ ...data, body: parsed.content.trim(), file: rel });
    }
  }
  const seen = new Map<string, string>();
  for (const m of result.memories) {
    const prev = seen.get(m.id);
    if (prev) result.problems.push({ file: m.file, error: `Duplicate id ${m.id} (also in ${prev}).` });
    else seen.set(m.id, m.file);
  }
  result.memories.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

function maxIdNumber(recallDir: string, loaded: Memory[]): number {
  let max = 0;
  for (const m of loaded) max = Math.max(max, Number(m.id.slice(4)));
  // Also consider ids embedded in filenames so malformed files never cause id reuse.
  for (const dir of MEMORY_DIRS) {
    for (const name of listMarkdown(recallDir, dir)) {
      const hit = /^mem_(\d+)/.exec(name);
      if (hit) max = Math.max(max, Number(hit[1]));
    }
  }
  return max;
}

export interface NewMemory {
  title: string;
  text: string;
  type?: MemoryType;
  tags?: string[];
  sources?: string[];
  status?: Lifecycle;
  confidence?: number;
  evidence?: string[];
  validFrom?: string;
  expiresAt?: string;
  version?: number;
  supersededBy?: string;
  deprecated?: boolean;
  deprecatedReason?: string;
  tenantId?: string;
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  visibility?: Visibility;
}

function serialize(meta: MemoryMeta, body: string): string {
  const ordered: Record<string, unknown> = {
    id: meta.id,
    title: meta.title,
    type: meta.type,
    created: meta.created,
    updated: meta.updated,
    tags: meta.tags,
    status: meta.status,
    verification: meta.verification,
    confidence: meta.confidence ?? 1.0,
    ...(meta.evidence && meta.evidence.length > 0 ? { evidence: meta.evidence } : {}),
    ...(meta.sources && meta.sources.length > 0 ? { sources: meta.sources } : {}),
    ...(meta.validFrom ? { validFrom: meta.validFrom } : {}),
    ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
    version: meta.version ?? 1,
    ...(meta.supersededBy ? { supersededBy: meta.supersededBy } : {}),
    ...(meta.deprecated ? { deprecated: meta.deprecated, deprecatedReason: meta.deprecatedReason } : {}),
    tenantId: meta.tenantId ?? 'default',
    workspaceId: meta.workspaceId ?? 'default',
    projectId: meta.projectId ?? 'default',
    ...(meta.userId ? { userId: meta.userId } : {}),
    visibility: meta.visibility ?? 'workspace',
  };
  return matter.stringify(`\n${body.trim()}\n`, ordered);
}

export function createMemory(recallDir: string, input: NewMemory): Memory {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) throw new RecallError('A memory needs a non-empty title.');
  if (!text) throw new RecallError('A memory needs non-empty text.');
  assertNoSecrets(`${title}\n${text}`);
  assertNotPoisoned(`${title}\n${text}`);

  const type = input.type ?? 'fact';
  const dir = TYPE_DIR[type];
  const loaded = loadAll(recallDir).memories;
  let n = maxIdNumber(recallDir, loaded) + 1;

  const confidence = input.confidence !== undefined ? input.confidence : 1.0;
  // Require explicit confirmation for low-confidence claims by forcing status: 'proposed'
  const forcedStatus = confidence < 0.7 ? 'proposed' : undefined;
  const verification: Verification = confidence < 0.7 ? 'needs_review' : 'unverified';

  for (let attempt = 0; attempt < 100; attempt++, n++) {
    const id = `mem_${String(n).padStart(3, '0')}`;
    const date = today();
    const meta: MemoryMeta = memoryMetaSchema.parse({
      id,
      title,
      type,
      created: date,
      updated: date,
      tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))],
      status: forcedStatus ?? input.status ?? (process.env.RECALL_AGENT === '1' ? 'proposed' : 'active'),
      verification,
      sources: input.sources ?? [],
      confidence,
      evidence: input.evidence ?? [],
      validFrom: input.validFrom ?? date,
      expiresAt: input.expiresAt,
      version: input.version ?? 1,
      supersededBy: input.supersededBy,
      deprecated: input.deprecated ?? false,
      deprecatedReason: input.deprecatedReason,
      tenantId: input.tenantId ?? 'default',
      workspaceId: input.workspaceId ?? 'default',
      projectId: input.projectId ?? 'default',
      userId: input.userId,
      visibility: input.visibility ?? 'workspace',
    });
    const name = `${id}-${slugify(title)}.md`;
    const abs = resolveInside(recallDir, dir, name);
    const body = text.startsWith('#') ? text : `# ${title}\n\n${text}`;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, serialize(meta, body), { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    return { ...meta, body, file: toPosix(path.join(dir, name)) };
  }
  throw new RecallError('Could not allocate a unique memory id.');
}

export function findMemory(recallDir: string, id: string): Memory {
  const m = loadAll(recallDir).memories.find((x) => x.id === id);
  if (!m) throw new RecallError(`No valid memory with id ${id}.`, 'Run `recall status` or `recall doctor` to inspect memory health.');
  return m;
}

export interface Patch {
  status?: Lifecycle;
  verification?: Verification;
  confidence?: number;
  evidence?: string[];
  expiresAt?: string;
  version?: number;
  supersededBy?: string;
  deprecated?: boolean;
  deprecatedReason?: string;
}

export function updateMemory(recallDir: string, id: string, patch: Patch): Memory {
  const m = findMemory(recallDir, id);
  const next: MemoryMeta = { ...m, ...patch, updated: today() };
  const abs = resolveInside(recallDir, ...m.file.split('/'));
  atomicWrite(abs, serialize(next, m.body));
  return { ...next, body: m.body, file: m.file };
}

/**
 * Replace a memory's text in place (same id and file). Latest knowledge wins so memory stays small;
 * tags and sources are merged. Git history keeps the previous wording.
 */
export function rewriteMemory(recallDir: string, id: string, input: NewMemory): Memory {
  const m = findMemory(recallDir, id);
  const title = input.title.trim() || m.title;
  const text = input.text.trim();
  if (!text) throw new RecallError('A memory needs non-empty text.');
  assertNoSecrets(`${title}\n${text}`);
  assertNotPoisoned(`${title}\n${text}`);

  const confidence = input.confidence !== undefined ? input.confidence : m.confidence ?? 1.0;
  const next: MemoryMeta = memoryMetaSchema.parse({
    ...m,
    title,
    updated: today(),
    version: (m.version ?? 1) + 1,
    tags: [...new Set([...m.tags, ...(input.tags ?? []).map((t) => t.trim()).filter(Boolean)])],
    sources: [...new Set([...m.sources, ...(input.sources ?? [])])],
    evidence: [...new Set([...(m.evidence ?? []), ...(input.evidence ?? [])])],
    confidence,
    status: confidence < 0.7 ? 'proposed' : (input.status ?? m.status),
    verification: confidence < 0.7 ? 'needs_review' : 'unverified',
    expiresAt: input.expiresAt ?? m.expiresAt,
    supersededBy: input.supersededBy ?? m.supersededBy,
    deprecated: input.deprecated ?? m.deprecated,
    deprecatedReason: input.deprecatedReason ?? m.deprecatedReason,
  });
  const body = text.startsWith('#') ? text : `# ${title}\n\n${text}`;
  atomicWrite(resolveInside(recallDir, ...m.file.split('/')), serialize(next, body));
  return { ...next, body, file: m.file };
}

export function appendChangelog(recallDir: string, action: string, m: { id: string; title: string }): void {
  const file = resolveInside(recallDir, 'logs', 'CHANGELOG.md');
  const line = `- ${today()} ${action} ${m.id} "${m.title.replace(/\s+/g, ' ')}"\n`;
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Recall changelog\n\n';
  atomicWrite(file, prev.endsWith('\n') ? prev + line : `${prev}\n${line}`);
}

