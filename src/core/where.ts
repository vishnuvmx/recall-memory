import fs from 'node:fs';
import path from 'node:path';
import { scanLandmarks, type Landmark } from './landmarks.js';
import { DEFAULT_IGNORED_DIRS, createGitignoreFilter } from './mapper.js';
import { toPosix } from '../utils/fs.js';

export interface WhereHit {
  file: string;
  line: number;
  name: string;
  kind: Landmark['kind'] | 'file';
  totalLines: number;
}

/**
 * Symbol/file lookup over live landmarks (mtime-cached in `.recall/.cache`), so results are never
 * stale and the agent pays for a handful of `file:line` rows instead of reading PROJECT_MAP.md.
 */
export function where(root: string, recallDir: string, query: string, limit = 15): WhereHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = scanLandmarks(root, 1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, recallDir);
  const ranked: Array<{ hit: WhereHit; rank: number }> = [];
  const seenFiles = new Set<string>();

  for (const f of files) {
    seenFiles.add(f.relativePath);
    const p = f.relativePath.toLowerCase();
    if (p.includes(q)) {
      const base = p.slice(p.lastIndexOf('/') + 1);
      ranked.push({ hit: { file: f.relativePath, line: 1, name: f.relativePath, kind: 'file', totalLines: f.totalLines }, rank: base === q ? 0 : base.startsWith(q) ? 1 : 3 });
    }
    for (const lm of f.landmarks) {
      const n = lm.name.toLowerCase();
      const rank = n === q ? 0 : n.startsWith(q) ? 2 : n.includes(q) ? 4 : -1;
      if (rank >= 0) ranked.push({ hit: { file: f.relativePath, line: lm.line, name: lm.name, kind: lm.kind, totalLines: f.totalLines }, rank });
    }
  }

  // Also check non-code project files (configs, package.json, Dockerfile, etc.)
  const isGitignored = createGitignoreFilter(root);
  function walk(currentDir: string, depth = 0): void {
    if (depth > 5) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(currentDir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isGitignored(rel, true)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (seenFiles.has(rel) || isGitignored(rel, false)) continue;
        const p = rel.toLowerCase();
        if (p.includes(q)) {
          let lineCount = 0;
          try {
            const stat = fs.statSync(full);
            if (stat.size <= 2 * 1024 * 1024) {
              lineCount = fs.readFileSync(full, 'utf8').split('\n').length;
            }
          } catch {
            // ignore unreadable
          }
          const base = p.slice(p.lastIndexOf('/') + 1);
          ranked.push({ hit: { file: rel, line: 1, name: rel, kind: 'file', totalLines: lineCount }, rank: base === q ? 0 : base.startsWith(q) ? 1 : 3 });
        }
      }
    }
  }
  walk(root);

  ranked.sort((a, b) => a.rank - b.rank || a.hit.file.localeCompare(b.hit.file) || a.hit.line - b.hit.line);
  return ranked.slice(0, limit).map((r) => r.hit);
}

export function formatWhere(hits: WhereHit[]): string {
  if (hits.length === 0) return 'No match.';
  return hits
    .map((h) => (h.kind === 'file' ? `${h.file} (${h.totalLines} lines)` : `${h.file}:${h.line} ${h.name} (${h.kind})`))
    .join('\n');
}
