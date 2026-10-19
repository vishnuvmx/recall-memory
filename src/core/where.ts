import { scanLandmarks, type Landmark } from './landmarks.js';

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

  for (const f of files) {
    const p = f.relativePath.toLowerCase();
    if (p.includes(q)) {
      const base = p.slice(p.lastIndexOf('/') + 1);
      ranked.push({ hit: { file: f.relativePath, line: 1, name: f.relativePath, kind: 'file', totalLines: f.totalLines }, rank: base.startsWith(q) ? 1 : 3 });
    }
    for (const lm of f.landmarks) {
      const n = lm.name.toLowerCase();
      const rank = n === q ? 0 : n.startsWith(q) ? 2 : n.includes(q) ? 4 : -1;
      if (rank >= 0) ranked.push({ hit: { file: f.relativePath, line: lm.line, name: lm.name, kind: lm.kind, totalLines: f.totalLines }, rank });
    }
  }

  ranked.sort((a, b) => a.rank - b.rank || a.hit.file.localeCompare(b.hit.file) || a.hit.line - b.hit.line);
  return ranked.slice(0, limit).map((r) => r.hit);
}

export function formatWhere(hits: WhereHit[]): string {
  if (hits.length === 0) return 'No match.';
  return hits
    .map((h) => (h.kind === 'file' ? `${h.file} (${h.totalLines} lines)` : `${h.file}:${h.line} ${h.name} (${h.kind})`))
    .join('\n');
}
