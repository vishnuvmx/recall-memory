import fs from 'node:fs';
import path from 'node:path';
import {
  extractLandmarks,
  loadLandmarksCache,
  saveLandmarksCache,
  syncLandmarksIncremental,
  type Landmark,
  type LandmarksCacheStore,
} from './landmarks.js';

export interface WhereHit {
  file: string;
  line: number;
  name: string;
  kind: Landmark['kind'] | 'file';
  totalLines: number;
}

function tokenizeQuery(q: string): string[] {
  // Split spaces, slashes, punctuation, AND camelCase boundaries (e.g. "token service" -> ["token", "service"])
  return q
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function rankTextMatch(textLower: string, qLower: string, queryTokens: string[], baseLower?: string): number {
  const target = baseLower ?? textLower;
  if (target === qLower || textLower === qLower) return 0;
  if (target.startsWith(qLower)) return 1;
  if (textLower.startsWith(qLower)) return 2;
  if (textLower.includes(qLower)) return 3;

  if (queryTokens.length >= 2) {
    // Match multi-word queries ("token service" -> AuthTokenService, "verify bearer" -> verifyBearerToken)
    if (queryTokens.every((t) => textLower.includes(t))) {
      return 2;
    }
  }
  return -1;
}

function queryStore(store: LandmarksCacheStore, qLower: string, queryTokens: string[]): Array<{ hit: WhereHit; rank: number }> {
  const ranked: Array<{ hit: WhereHit; rank: number }> = [];

  for (const [rel, rec] of Object.entries(store.files)) {
    const pLower = rel.toLowerCase();
    const baseLower = pLower.slice(pLower.lastIndexOf('/') + 1);

    const fileRank = rankTextMatch(pLower, qLower, queryTokens, baseLower);
    if (fileRank >= 0) {
      // Slightly prefer symbol matches over file path matches when multi-token query matches both
      const adjusted = queryTokens.length >= 2 && fileRank === 2 ? 4 : fileRank;
      ranked.push({
        hit: { file: rel, line: 1, name: rel, kind: 'file', totalLines: rec.totalLines },
        rank: adjusted,
      });
    }

    for (const lm of rec.landmarks) {
      const nLower = lm.name.toLowerCase();
      let symRank = rankTextMatch(nLower, qLower, queryTokens);
      if (symRank < 0 && queryTokens.length >= 2) {
        const combined = `${pLower} ${nLower}`;
        if (queryTokens.some((t) => nLower.includes(t)) && queryTokens.every((t) => combined.includes(t))) {
          symRank = 5;
        }
      }
      if (symRank >= 0) {
        ranked.push({
          hit: { file: rel, line: lm.line, name: lm.name, kind: lm.kind, totalLines: rec.totalLines },
          rank: symRank,
        });
      }
    }
  }

  for (const [rel, meta] of Object.entries(store.otherFiles)) {
    const pLower = rel.toLowerCase();
    const baseLower = pLower.slice(pLower.lastIndexOf('/') + 1);
    const rank = rankTextMatch(pLower, qLower, queryTokens, baseLower);
    if (rank >= 0) {
      ranked.push({
        hit: { file: rel, line: 1, name: rel, kind: 'file', totalLines: meta.totalLines ?? 0 },
        rank,
      });
    }
  }

  ranked.sort((a, b) => a.rank - b.rank || a.hit.file.localeCompare(b.hit.file) || a.hit.line - b.hit.line);
  return ranked;
}

/**
 * Symbol/file lookup over cached landmarks (`.recall/.cache/landmarks-cache.json`).
 * - Warm path performs ZERO repository directory walks: reads the cached index and lazily
 *   verifies/refreshes only the top matched files (evicting deleted files or updating shifted lines).
 * - Automatically falls back to a single-pass incremental index scan if the cache is missing or
 *   returns 0 hits (in case a brand-new file was created since the last sync).
 */
export function where(root: string, recallDir: string, query: string, limit = 15): WhereHit[] {
  const qRaw = query.trim();
  const qLower = qRaw.toLowerCase();
  if (!qLower) return [];
  const queryTokens = tokenizeQuery(qRaw);

  let store = loadLandmarksCache(recallDir);
  let wasWarm = store !== null;

  if (!store) {
    store = syncLandmarksIncremental(root, recallDir).store;
    wasWarm = false;
  }

  let ranked = queryStore(store, qLower, queryTokens);

  // If warm cache found nothing, perform one incremental refresh in case a new file was added
  if (wasWarm && ranked.length === 0) {
    store = syncLandmarksIncremental(root, recallDir).store;
    wasWarm = false;
    ranked = queryStore(store, qLower, queryTokens);
  }

  if (ranked.length === 0) return [];

  // Lazily verify only the candidate files we are about to return (typically 1-5 files, 0 dir walks!)
  if (wasWarm) {
    const candidateFiles = [...new Set(ranked.slice(0, limit * 2).map((r) => r.hit.file))];
    let cacheMutated = false;

    for (const rel of candidateFiles) {
      const fullPath = path.join(root, rel);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        stat = null;
      }

      if (!stat || !stat.isFile()) {
        if (store.files[rel]) {
          delete store.files[rel];
          cacheMutated = true;
        }
        if (store.otherFiles[rel]) {
          delete store.otherFiles[rel];
          cacheMutated = true;
        }
        continue;
      }

      const codeRec = store.files[rel];
      if (codeRec && (codeRec.mtimeMs !== stat.mtimeMs || codeRec.size !== stat.size)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const ext = path.extname(rel).toLowerCase();
          store.files[rel] = {
            v: store.v,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            totalLines: content.split('\n').length,
            landmarks: extractLandmarks(content, ext),
          };
          cacheMutated = true;
        } catch {
          // ignore unreadable
        }
      }
    }

    if (cacheMutated) {
      saveLandmarksCache(recallDir, store);
      ranked = queryStore(store, qLower, queryTokens);
    }
  }

  // Fill line counts lazily only for returned non-code file hits if needed
  const topHits = ranked.slice(0, limit).map((r) => r.hit);
  for (const hit of topHits) {
    if (hit.kind === 'file' && hit.totalLines === 0 && store.otherFiles[hit.file]) {
      try {
        const fullPath = path.join(root, hit.file);
        const stat = fs.statSync(fullPath);
        if (stat.size <= 2 * 1024 * 1024) {
          hit.totalLines = fs.readFileSync(fullPath, 'utf8').split('\n').length;
        }
      } catch {
        // ignore
      }
    }
  }

  return topHits;
}

export function formatWhere(hits: WhereHit[]): string {
  if (hits.length === 0) return 'No match.';
  return hits
    .map((h) => (h.kind === 'file' ? `${h.file} (${h.totalLines} lines)` : `${h.file}:${h.line} ${h.name} (${h.kind})`))
    .join('\n');
}
