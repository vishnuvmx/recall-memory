import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { scanLandmarks, type FileLandmarks } from './landmarks.js';
import { loadSearchableMemories, type Memory } from './memory.js';
import { computeMemoriesDigest } from './sqlite-store.js';
import type { ProfileTier } from '../schemas/index.js';
import { atomicWrite, resolveInside } from '../utils/fs.js';
import { applyManagedBlock } from '../utils/managed.js';

export const PASSPORT_BLOCK_NAME = 'recall:passport';
const FINGERPRINT_VERSION = 1;

export interface WorkspaceFingerprint {
  version: number;
  passportHash?: string;
  mapHash?: string;
  memoriesHash?: string;
  lastChatTurnHash?: string;
  lastConversationId?: string;
}

export interface ProjectIdentity {
  name: string;
  purpose: string;
  stack: string[];
  dependencies: string[];
  scripts: Array<{ name: string; cmd: string }>;
}

export interface PassportSyncResult {
  file: string;
  updated: boolean;
  passportHash: string;
  tokensEstimate: number;
}

function fingerprintPath(recallDir: string): string {
  return path.join(recallDir, '.cache', 'fingerprint.json');
}

export function loadFingerprint(recallDir: string): WorkspaceFingerprint {
  const file = fingerprintPath(recallDir);
  if (!fs.existsSync(file)) return { version: FINGERPRINT_VERSION };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceFingerprint;
    if (parsed.version !== FINGERPRINT_VERSION) return { version: FINGERPRINT_VERSION };
    return parsed;
  } catch {
    return { version: FINGERPRINT_VERSION };
  }
}

export function saveFingerprint(recallDir: string, next: WorkspaceFingerprint): void {
  const file = fingerprintPath(recallDir);
  try {
    atomicWrite(file, `${JSON.stringify({ ...next, version: FINGERPRINT_VERSION }, null, 2)}\n`);
  } catch {
    // Non-fatal if cache cannot be written
  }
}

function readSafe(filePath: string, maxBytes = 65536): string {
  try {
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) return '';
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytes = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function extractReadmeSummary(root: string): string {
  const raw = readSafe(path.join(root, 'README.md'), 8192);
  if (!raw) return '';
  const withoutHtml = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
  const lines = withoutHtml.split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      const joined = current.join(' ').replace(/\s+/g, ' ').trim();
      if (joined.length >= 25) paragraphs.push(joined);
      current = [];
    }
  };

  for (const rawLine of lines) {
    const l = rawLine.trim();
    if (!l) {
      flush();
      continue;
    }
    if (
      l.startsWith('#') ||
      l.startsWith('![') ||
      l.startsWith('[![') ||
      l.startsWith('|') ||
      l.startsWith('---') ||
      l.startsWith('```') ||
      l.startsWith('- [') ||
      /^\[[^\]]+\]\([^)]+\)\s*[•·|]/.test(l)
    ) {
      flush();
      continue;
    }
    const clean = l.replace(/^>\s*(\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])?\s*/i, '').trim();
    if (clean) current.push(clean);
  }
  flush();

  const best = paragraphs.find((p) => !/^status:\s*alpha/i.test(p)) ?? paragraphs[0] ?? '';
  return best.length > 240 ? `${best.slice(0, 237)}...` : best;
}

export function extractProjectIdentity(root: string): ProjectIdentity {
  let name = path.basename(root);
  let purpose = '';
  const stack: string[] = [];
  const dependencies: string[] = [];
  const scripts: Array<{ name: string; cmd: string }> = [];

  const pkgRaw = readSafe(path.join(root, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        name?: string;
        description?: string;
        type?: string;
        engines?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      if (pkg.name) name = pkg.name;
      if (pkg.description) purpose = pkg.description.trim();

      const nodeVer = pkg.engines?.node ? `Node.js ${pkg.engines.node}` : 'Node.js';
      stack.push(pkg.type === 'module' ? `${nodeVer} (ESM)` : nodeVer);
      if (pkg.devDependencies?.typescript || fs.existsSync(path.join(root, 'tsconfig.json'))) {
        stack.push('TypeScript');
      }
      const deps = Object.keys(pkg.dependencies ?? {});
      dependencies.push(...deps.slice(0, 15));

      const priorityScripts = ['build', 'typecheck', 'test', 'lint', 'dev', 'start', 'sync', 'bench'];
      const entries = Object.entries(pkg.scripts ?? {});
      entries.sort((a, b) => {
        const ia = priorityScripts.indexOf(a[0]);
        const ib = priorityScripts.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
      });
      for (const [k, v] of entries.slice(0, 8)) {
        if (k === 'prepare' || k === 'prepublishOnly' || k.startsWith('pre') || k.startsWith('post')) continue;
        scripts.push({ name: `npm run ${k}`, cmd: v });
      }
    } catch {
      // ignore malformed package.json
    }
  }

  const cargoRaw = readSafe(path.join(root, 'Cargo.toml'));
  if (cargoRaw) {
    stack.push('Rust (Cargo)');
    const mName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargoRaw);
    const mDesc = /^\s*description\s*=\s*"([^"]+)"/m.exec(cargoRaw);
    if (mName?.[1] && name === path.basename(root)) name = mName[1];
    if (mDesc?.[1] && !purpose) purpose = mDesc[1];
    scripts.push({ name: 'cargo check', cmd: 'typecheck & borrow-check' }, { name: 'cargo test', cmd: 'run test suite' });
  }

  const pyRaw = readSafe(path.join(root, 'pyproject.toml'));
  if (pyRaw || fs.existsSync(path.join(root, 'requirements.txt'))) {
    stack.push('Python');
    const mName = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyRaw);
    const mDesc = /^\s*description\s*=\s*"([^"]+)"/m.exec(pyRaw);
    if (mName?.[1] && name === path.basename(root)) name = mName[1];
    if (mDesc?.[1] && !purpose) purpose = mDesc[1];
  }

  if (fs.existsSync(path.join(root, 'go.mod'))) {
    stack.push('Go');
    scripts.push({ name: 'go test ./...', cmd: 'run Go package tests' });
  }

  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) {
    stack.push('Flutter / Dart');
  }

  const readmeSummary = extractReadmeSummary(root);
  if (!purpose && readmeSummary) {
    purpose = readmeSummary;
  } else if (purpose && readmeSummary && !readmeSummary.toLowerCase().includes(purpose.toLowerCase().slice(0, 25))) {
    const combined = `${purpose} ${readmeSummary}`;
    purpose = combined.length > 260 ? `${combined.slice(0, 257)}...` : combined;
  }

  if (stack.length === 0) stack.push('Generic Workspace');

  return { name, purpose, stack, dependencies, scripts };
}

function summarizeMemoryOneLine(m: Memory): string {
  const lines = m.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('---'));
  const first = lines[0] ?? '';
  const clean = first.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
  const short = clean.length > 140 ? `${clean.slice(0, 137)}...` : clean;
  return short && short.toLowerCase() !== m.title.toLowerCase()
    ? `**[${m.type}] ${m.title}**: ${short}`
    : `**[${m.type}] ${m.title}**`;
}

function extractBulletsFromPlainDoc(body: string, maxBullets = 5): string[] {
  const bullets: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
    const text = line.slice(2).trim();
    if (!text || text.startsWith('(Add ') || text.includes('[INDEX.md]')) continue;
    bullets.push(text.length > 160 ? `${text.slice(0, 157)}...` : text);
    if (bullets.length >= maxBullets) break;
  }
  return bullets;
}

export function buildPassportMarkdown(
  identity: ProjectIdentity,
  files: FileLandmarks[],
  memories: Memory[],
  maxChars = 4000,
): string {
  const lines: string[] = [
    '# Project Passport (Non-Volatile Blueprint)',
    '',
    '> **AI MODELS**: Non-volatile architecture, commands, module exports, and durable rules. Read this once per new chat instead of cold-scanning the repository. Use `recall where <symbol>` for exact line numbers and `recall context "<topic>"` for deeper history.',
    '',
    '## 1. Identity & Tech Stack',
    `- **Project**: \`${identity.name}\``,
  ];

  if (identity.purpose) {
    lines.push(`- **Purpose**: ${identity.purpose}`);
  }
  lines.push(`- **Stack**: ${identity.stack.join(' · ')}`);
  if (identity.dependencies.length > 0) {
    lines.push(`- **Runtime Dependencies**: \`${identity.dependencies.join('`, `')}\``);
  }
  lines.push('');

  if (identity.scripts.length > 0) {
    lines.push('## 2. Verified Commands');
    for (const s of identity.scripts) {
      lines.push(`- \`${s.name}\` → \`${s.cmd}\``);
    }
    lines.push('');
  }

  // Group non-volatile module exports (sorted deterministically by path, no volatile line numbers!)
  const sortedFiles = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const moduleLines: string[] = [];
  for (const f of sortedFiles) {
    const exportedSyms = f.landmarks.filter((lm) => lm.exported && lm.kind !== 'section').map((lm) => lm.name);
    const fallbackSyms = exportedSyms.length > 0
      ? exportedSyms
      : f.landmarks.filter((lm) => lm.kind !== 'section').map((lm) => lm.name);
    const uniqueSyms = [...new Set(fallbackSyms)].slice(0, 6);
    if (uniqueSyms.length > 0) {
      moduleLines.push(`- \`${f.relativePath}\`: \`${uniqueSyms.join('`, `')}\``);
    } else {
      moduleLines.push(`- \`${f.relativePath}\``);
    }
  }

  // Durable invariants & active memories (placed BEFORE module list overflow truncation if needed)
  const invariantLines: string[] = [];
  const docMem = memories.find((m) => m.id === 'doc_memory');
  if (docMem) {
    for (const b of extractBulletsFromPlainDoc(docMem.body, 6)) {
      invariantLines.push(`- ${b}`);
    }
  }
  for (const ruleDoc of memories.filter((m) => m.id.startsWith('doc_rules_'))) {
    for (const b of extractBulletsFromPlainDoc(ruleDoc.body, 3)) {
      invariantLines.push(`- ${b}`);
    }
  }

  const structuredActive = memories
    .filter((m) => !m.id.startsWith('doc_') && m.status === 'active' && !m.deprecated)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const m of structuredActive.slice(0, 15)) {
    invariantLines.push(`- ${summarizeMemoryOneLine(m)} _(${m.id})_`);
  }

  if (invariantLines.length > 0) {
    lines.push('## 3. Non-Volatile Rules, Decisions & Invariants');
    lines.push(...invariantLines);
    lines.push('');
  }

  if (moduleLines.length > 0) {
    lines.push('## 4. Core Modules & Exported Surface');
    const currentLen = lines.join('\n').length;
    const budgetForModules = Math.max(600, maxChars - currentLen - 160);
    let used = 0;
    let shown = 0;
    for (const ml of moduleLines) {
      if (used + ml.length + 1 > budgetForModules) break;
      lines.push(ml);
      used += ml.length + 1;
      shown++;
    }
    if (shown < moduleLines.length) {
      lines.push(`- _... (${moduleLines.length - shown} more modules — query \`recall where <name>\`)_`);
    }
    lines.push('');
  }

  let out = lines.join('\n').trimEnd();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars - 100);
    const lastNl = cut.lastIndexOf('\n');
    out = `${cut.slice(0, lastNl > 0 ? lastNl : cut.length)}\n\n> _[Passport capped at ${maxChars} chars. Use \`recall context\` or \`recall where\` for details.]_`;
  }
  return out;
}

export function computePassportHash(
  identity: ProjectIdentity,
  files: FileLandmarks[],
  memories: Memory[],
  profile: ProfileTier,
): string {
  const h = crypto.createHash('sha256');
  h.update(`profile:${profile}\n`);
  h.update(JSON.stringify(identity));
  const sortedFiles = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const f of sortedFiles) {
    const syms = f.landmarks
      .filter((lm) => lm.kind !== 'section')
      .map((lm) => `${lm.exported ? 'E' : 'I'}:${lm.kind}:${lm.name}`)
      .join(',');
    h.update(`\nfile:${f.relativePath}:${syms}`);
  }
  h.update(`\nmem:${computeMemoriesDigest(memories)}`);
  return h.digest('hex');
}

export function passportMaxChars(profile: ProfileTier): number {
  if (profile === 'compact') return 2400;
  if (profile === 'frontier') return 8000;
  return 4200;
}

/**
 * Incrementally generates or updates `.recall/PASSPORT.md`.
 * Skips rewriting (0 cold re-analysis) when the non-volatile structural + memory hash is unchanged.
 */
export function syncPassport(
  root: string,
  recallDir: string,
  opts: { profile?: ProfileTier; force?: boolean } = {},
): PassportSyncResult {
  let profile: ProfileTier = opts.profile ?? 'standard';
  if (!opts.profile) {
    try {
      profile = loadConfig(recallDir).profile ?? 'standard';
    } catch {
      profile = 'standard';
    }
  }

  const identity = extractProjectIdentity(root);
  const files = scanLandmarks(root, 1, Number.POSITIVE_INFINITY, 16, recallDir);
  const searchable = loadSearchableMemories(recallDir);
  const passportHash = computePassportHash(identity, files, searchable, profile);

  const file = resolveInside(recallDir, 'PASSPORT.md');
  const fp = loadFingerprint(recallDir);

  if (!opts.force && fp.passportHash === passportHash && fs.existsSync(file)) {
    const existingLen = fs.statSync(file).size;
    return {
      file,
      updated: false,
      passportHash,
      tokensEstimate: Math.ceil(existingLen / 4),
    };
  }

  const markdown = buildPassportMarkdown(identity, files, searchable, passportMaxChars(profile));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rendered = applyManagedBlock(existing, markdown, PASSPORT_BLOCK_NAME);

  let wrote = false;
  if (rendered !== existing) {
    atomicWrite(file, rendered);
    wrote = true;
  }

  saveFingerprint(recallDir, {
    ...fp,
    passportHash,
    memoriesHash: computeMemoriesDigest(searchable),
  });

  return {
    file,
    updated: wrote,
    passportHash,
    tokensEstimate: Math.ceil(rendered.length / 4),
  };
}
