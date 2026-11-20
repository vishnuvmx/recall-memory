import crypto from 'node:crypto';
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
  /** Active memories referencing repo-relative code files that no longer exist on disk. */
  staleFileRefs?: string[];
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
    let dirAbs: string;
    try {
      dirAbs = resolveInside(recallDir, dir);
    } catch {
      continue;
    }
    for (const name of listMarkdown(recallDir, dir)) {
      const rel = `${dir}/${name}`;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(dirAbs, name), 'utf8');
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

/**
 * Fast stat-only fingerprint across `.recall/` Markdown memory & rule files (zero file reads).
 * Used to avoid re-reading and YAML-parsing unchanged Markdown files on read queries and idle hooks.
 */
export function computeRecallFilesStatKey(recallDir: string): string {
  const parts: string[] = [];
  const memMd = path.join(recallDir, 'MEMORY.md');
  try {
    if (fs.existsSync(memMd)) {
      const st = fs.statSync(memMd);
      parts.push(`M:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  } catch {
    // ignore
  }
  for (const sub of MEMORY_DIRS) {
    const dir = path.join(recallDir, sub);
    try {
      if (!fs.existsSync(dir)) continue;
      const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort();
      for (const n of names) {
        const st = fs.statSync(path.join(dir, n));
        parts.push(`${sub}/${n}:${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    } catch {
      // ignore
    }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

const REPO_FILE_REF_RE = /(?:^|[\s`'"])((?:src|lib|app|packages|scripts|tests|test|cmd|internal)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java))(?=[\s`'":,.)]|$)/g;

export function detectStaleFileRefs(recallDir: string, memories: Memory[]): string[] {
  const repoRoot = path.dirname(path.resolve(recallDir));
  const existingTopDirs = new Map<string, boolean>();
  const stale: string[] = [];
  const seen = new Set<string>();

  const checkRelPath = (memId: string, rawPath: string): void => {
    const rel = rawPath.replace(/\\/g, '/').trim();
    const topDir = rel.split('/')[0];
    if (!topDir) return;
    let hasTop = existingTopDirs.get(topDir);
    if (hasTop === undefined) {
      try {
        hasTop = fs.existsSync(path.join(repoRoot, topDir)) && fs.statSync(path.join(repoRoot, topDir)).isDirectory();
      } catch {
        hasTop = false;
      }
      existingTopDirs.set(topDir, hasTop);
    }
    if (!hasTop) return;
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot + path.sep)) return;
    if (!fs.existsSync(abs)) {
      const key = `${memId}:${rel}`;
      if (!seen.has(key)) {
        seen.add(key);
        stale.push(`${memId} (${rel})`);
      }
    }
  };

  for (const m of memories) {
    if (m.status !== 'active' || m.deprecated) continue;
    for (const src of m.sources ?? []) {
      if (/^(?:src|lib|app|packages|scripts|tests|test|cmd|internal)\//.test(src)) {
        checkRelPath(m.id, src);
      }
    }
    const text = `${m.title}\n${m.body}`;
    REPO_FILE_REF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REPO_FILE_REF_RE.exec(text)) !== null) {
      if (match[1]) checkRelPath(m.id, match[1]);
    }
  }
  return stale;
}

const BOILERPLATE_SNIPPETS = [
  '(Add the few rules that must never be broken.)',
  'Describe the architecture constraints agents must preserve.',
  'Describe naming, formatting, and structure conventions.',
  'List design tokens/components and the checks that enforce them.',
  'Describe build, test, and release commands agents should use.',
];

function isBoilerplateDoc(raw: string): boolean {
  let stripped = raw;
  for (const s of BOILERPLATE_SNIPPETS) {
    stripped = stripped.replace(s, '');
  }
  stripped = stripped
    .replace(/Short overview of this project\. Edit this file by hand; Recall never overwrites it\./g, '')
    .replace(/Detailed knowledge is indexed in \[INDEX\.md\]\(INDEX\.md\)\.[^\n]*/g, '')
    .replace(/^#+\s+.*$/gm, '')
    .trim();
  return stripped.length < 10;
}

/**
 * Loads all structured memories PLUS hand-curated non-volatile Markdown documents
 * (`MEMORY.md` and plain `rules/*.md`) as searchable records so `recall context`
 * and SQLite FTS5/vector search never miss human-authored project rules.
 */
export function loadSearchableMemories(recallDir: string, preloaded?: LoadResult): Memory[] {
  const loaded = preloaded ?? loadAll(recallDir);
  const out: Memory[] = [...loaded.memories];

  const addPlainDoc = (relPath: string, defaultTitle: string, defaultTags: string[], memType: MemoryType = 'convention'): void => {
    try {
      const abs = resolveInside(recallDir, ...relPath.split('/'));
      if (!fs.existsSync(abs) || fs.lstatSync(abs).isSymbolicLink()) return;
      const raw = fs.readFileSync(abs, 'utf8');
      if (isBoilerplateDoc(raw)) return;
      const stat = fs.statSync(abs);
      const dateStr = stat.mtime.toISOString().slice(0, 10);
      const headingMatch = /^#\s+(.+)$/m.exec(raw);
      const title = headingMatch?.[1]?.trim() || defaultTitle;
      const slug = slugify(relPath.replace(/\.md$/i, ''));
      out.push({
        id: `doc_${slug.replace(/-/g, '_')}`,
        title,
        type: memType,
        created: dateStr,
        updated: dateStr,
        tags: defaultTags,
        status: 'active',
        verification: 'verified',
        sources: [relPath],
        confidence: 1.0,
        evidence: [],
        version: 1,
        deprecated: false,
        tenantId: 'default',
        workspaceId: 'default',
        projectId: 'default',
        visibility: 'workspace',
        body: raw.trim(),
        file: relPath,
      });
    } catch {
      // Ignore unreadable plain docs
    }
  };

  addPlainDoc('MEMORY.md', 'Project Core Constraints & Memory', ['memory', 'invariants', 'constraints', 'architecture'], 'convention');

  for (const rel of loaded.plainDocs) {
    const base = path.basename(rel, '.md');
    const memType: MemoryType = base.includes('design') ? 'design_system' : 'convention';
    addPlainDoc(rel, `Rule: ${base}`, ['rules', base], memType);
  }

  return out;
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

const AUTO_TAG_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'where', 'what', 'which',
  'always', 'never', 'must', 'should', 'avoid', 'prefer', 'use', 'using', 'used', 'instead',
  'rule', 'memory', 'decision', 'convention', 'lesson', 'bugfix', 'task', 'fact', 'fix', 'fixed',
  'bug', 'issue', 'error', 'add', 'added', 'update', 'updated', 'remove', 'removed', 'change',
  'file', 'files', 'code', 'project', 'repo', 'all', 'any', 'not', 'only', 'can', 'will',
]);

function inferTagsForMemory(title: string, text: string, loaded: Memory[]): string[] {
  const combinedLower = `${title} ${text}`.toLowerCase();
  const wordSet = new Set(combinedLower.match(/[a-z0-9_-]{3,}/g) ?? []);
  const inferred: string[] = [];
  const seen = new Set<string>();

  // 1. Reuse existing active project tags that appear in this memory's text/title
  const corpusTagFreq = new Map<string, number>();
  for (const m of loaded) {
    if (m.status !== 'active' || m.deprecated) continue;
    for (const rawTag of m.tags) {
      const t = rawTag.toLowerCase().trim();
      if (t.length >= 3) corpusTagFreq.set(t, (corpusTagFreq.get(t) ?? 0) + 1);
    }
  }
  const matchingCorpusTags = [...corpusTagFreq.entries()]
    .filter(([tag]) => wordSet.has(tag) || combinedLower.includes(tag))
    .sort((a, b) => b[1] - a[1]);

  for (const [tag] of matchingCorpusTags) {
    if (!seen.has(tag)) {
      seen.add(tag);
      inferred.push(tag);
      if (inferred.length >= 4) return inferred;
    }
  }

  // 2. Fall back to high-signal technical tokens from the title
  const titleTokens = title.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const tok of titleTokens) {
    if (AUTO_TAG_STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    inferred.push(tok);
    if (inferred.length >= 4) break;
  }

  return inferred;
}

export function createMemory(recallDir: string, input: NewMemory, preloaded?: Memory[]): Memory {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) throw new RecallError('A memory needs a non-empty title.');
  if (!text) throw new RecallError('A memory needs non-empty text.');
  assertNoSecrets(`${title}\n${text}`);
  assertNotPoisoned(`${title}\n${text}`);

  const type = input.type ?? 'fact';
  const dir = TYPE_DIR[type];
  const loaded = preloaded ?? loadAll(recallDir).memories;
  let n = maxIdNumber(recallDir, loaded) + 1;

  const confidence = input.confidence !== undefined ? input.confidence : 1.0;
  // Require explicit confirmation for low-confidence claims by forcing status: 'proposed'
  const forcedStatus = confidence < 0.7 ? 'proposed' : undefined;
  const verification: Verification = confidence < 0.7 ? 'needs_review' : 'unverified';
  const explicitTags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  const finalTags = explicitTags.length > 0 ? explicitTags : inferTagsForMemory(title, text, loaded);

  for (let attempt = 0; attempt < 100; attempt++, n++) {
    const id = `mem_${String(n).padStart(3, '0')}`;
    const date = today();
    const meta: MemoryMeta = memoryMetaSchema.parse({
      id,
      title,
      type,
      created: date,
      updated: date,
      tags: finalTags,
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

