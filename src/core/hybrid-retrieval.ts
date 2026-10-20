import type { Memory } from './memory.js';
import type { MemoryType } from '../schemas/index.js';
import type { SecurityContext } from '../security/isolation.js';
import { canReadResource, getSecurityContext } from '../security/isolation.js';
import { isMemoryExpired } from './conflict.js';
import { cosineSimilarity, getOrGenerateEmbedding } from './embeddings.js';
import { tokenize } from './retrieval.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

export interface HybridSearchOptions {
  limit?: number;
  maxTokens?: number;
  maxChars?: number;
  type?: MemoryType;
  tag?: string;
  includeProposed?: boolean;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  minScore?: number;
  securityContext?: SecurityContext;
  sqliteStore?: SqliteMemoryStore;
}

export interface HybridSearchHit {
  memory: Memory;
  score: number;
  scoreBreakdown: {
    exactMatch: number;
    bm25: number;
    vectorSimilarity: number;
    recency: number;
    confidenceMultiplier: number;
  };
  excerpt: string;
}

const IDENTIFIER_REGEXES: RegExp[] = [
  // Error codes: ERR_..., SQLITE_..., EEXIST, 404
  /\b[A-Z0-9_]{3,}_[A-Z0-9_]+\b/g,
  /\bE[A-Z]{3,}\b/g,
  // Filenames: index.ts, Dockerfile, config.json
  /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,5}\b/g,
  // Code identifiers: camelCase, PascalCase, snake_case
  /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g,
  /\b[A-Z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b/g,
  // CLI commands or options: --profile, npm run ...
  /\b(?:npm|git|recall|docker|node|cargo|pnpm|yarn)\s+[a-z_-]+/gi,
  /--[a-z0-9_-]+/gi,
];

/**
 * Extracts exact technical identifiers from query (filenames, error codes, function names).
 */
export function extractTechnicalIdentifiers(query: string): string[] {
  const matches = new Set<string>();
  for (const re of IDENTIFIER_REGEXES) {
    const hits = query.match(re) ?? [];
    for (const h of hits) {
      if (h.length >= 3) {
        matches.add(h.toLowerCase());
      }
    }
  }
  return [...matches];
}

function excerptFor(body: string, tokens: string[]): string {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !/^#{1,6}\s/.test(l));
  const hit = lines.find((l) => tokens.some((t) => l.toLowerCase().includes(t))) ?? lines[0] ?? '';
  return hit.length > 220 ? `${hit.slice(0, 217)}...` : hit;
}

/**
 * Executes hybrid retrieval across candidate memories:
 * 1. Data isolation & tenant filtering
 * 2. Expiration and superseded filtering
 * 3. Exact technical identifier match boost
 * 4. BM25 keyword score (via FTS5 or token frequency)
 * 5. Dense vector semantic similarity
 * 6. Recency weighting and confidence decay
 */
export function hybridSearch(
  memories: Memory[],
  query: string,
  opts: HybridSearchOptions = {},
): HybridSearchHit[] {
  const qTrim = query.trim();
  if (!qTrim) return [];

  const callerContext = opts.securityContext || getSecurityContext();
  const tokens = tokenize(qTrim);
  const identifiers = extractTechnicalIdentifiers(qTrim);
  const qLower = qTrim.toLowerCase();

  // 1. Precompute query dense embedding
  const queryEmbedding = getOrGenerateEmbedding(qTrim).vector;

  // 2. Precompute FTS5 BM25 scores if sqlite store is provided
  const ftsScores = new Map<string, number>();
  if (opts.sqliteStore) {
    const hits = opts.sqliteStore.ftsBm25Search(qTrim, 50);
    for (const h of hits) {
      ftsScores.set(h.id, h.bm25Score);
    }
  }

  const now = Date.now();
  const rawHits: HybridSearchHit[] = [];

  for (const m of memories) {
    // 1. Enforce strict data isolation
    if (!canReadResource(callerContext, m)) {
      continue;
    }

    // 2. Filter lifecycle and outdated facts
    if (m.status === 'archived' && !opts.includeArchived) continue;
    if (m.status === 'proposed' && !opts.includeProposed) continue;
    if (m.status === 'superseded' && !opts.includeSuperseded) continue;
    if (isMemoryExpired(m)) continue;
    if (opts.type && m.type !== opts.type) continue;
    if (opts.tag && !m.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) continue;

    const titleLower = m.title.toLowerCase();
    const bodyLower = m.body.toLowerCase();
    const tagsLower = m.tags.join(' ').toLowerCase();

    // 3. Exact Match Scoring (Identifiers, error codes, filenames, exact phrases)
    let exactScore = 0;
    if (titleLower === qLower) {
      exactScore += 20;
    } else if (titleLower.includes(qLower)) {
      exactScore += 10;
    }

    for (const idf of identifiers) {
      if (titleLower.includes(idf)) exactScore += 12;
      else if (tagsLower.includes(idf)) exactScore += 8;
      else if (bodyLower.includes(idf)) exactScore += 6;
    }

    // 4. BM25 Keyword Scoring
    let bm25Score = 0;
    if (ftsScores.has(m.id)) {
      bm25Score = ftsScores.get(m.id)! * 2.0;
    } else {
      // In-memory BM25 approximation
      let matchedTokenCount = 0;
      for (const tok of tokens) {
        if (titleLower.includes(tok)) {
          bm25Score += 3.5;
          matchedTokenCount++;
        } else if (tagsLower.includes(tok)) {
          bm25Score += 2.0;
          matchedTokenCount++;
        } else if (bodyLower.includes(tok)) {
          bm25Score += 1.0;
          matchedTokenCount++;
        }
      }
      if (tokens.length > 0 && matchedTokenCount > 0) {
        bm25Score += (matchedTokenCount / tokens.length) * 3.0;
      }
    }

    // 5. Dense Vector Similarity
    const memEmbedding = opts.sqliteStore?.getEmbedding(m.id) ?? getOrGenerateEmbedding(`${m.title}\n${m.body}`).vector;
    const similarity = Math.max(0, cosineSimilarity(queryEmbedding, memEmbedding));
    const vectorScore = similarity * 8.0;

    // Must have at least some match to be considered
    if (exactScore === 0 && bm25Score === 0 && similarity < 0.45) {
      continue;
    }

    // 6. Recency Weighting
    let recencyScore = 0;
    try {
      const dateStr = m.updated || m.created;
      const ageDays = (now - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 7) recencyScore += 1.5;
      else if (ageDays <= 30) recencyScore += 0.8;
      else if (ageDays <= 90) recencyScore += 0.3;
    } catch {
      // ignore date parse errors
    }

    // 7. Confidence & Verification Weighting
    const confidenceMultiplier = Math.max(0.1, m.confidence ?? 1.0);
    const verificationBonus = m.verification === 'verified' ? 0.5 : 0;

    // Status weighting
    const statusWeight: Record<string, number> = {
      active: 1.0,
      proposed: 0.5,
      superseded: 0.2,
      archived: 0.1,
    };
    const sWeight = statusWeight[m.status] ?? 1.0;

    const baseScore = exactScore + bm25Score + vectorScore + recencyScore + verificationBonus;
    const finalScore = Math.round(baseScore * sWeight * confidenceMultiplier * 100) / 100;

    if (opts.minScore && finalScore < opts.minScore) continue;

    rawHits.push({
      memory: m,
      score: finalScore,
      scoreBreakdown: {
        exactMatch: exactScore,
        bm25: Math.round(bm25Score * 100) / 100,
        vectorSimilarity: Math.round(vectorScore * 100) / 100,
        recency: recencyScore,
        confidenceMultiplier,
      },
      excerpt: excerptFor(m.body, tokens.concat(identifiers)),
    });
  }

  // Sort by final score descending
  rawHits.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));

  // Deduplication / Near-duplicate suppression in retrieval results
  const deduplicatedHits: HybridSearchHit[] = [];
  const seenTitles = new Set<string>();

  for (const hit of rawHits) {
    const norm = hit.memory.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenTitles.has(norm)) continue;
    seenTitles.add(norm);
    deduplicatedHits.push(hit);
  }

  const limit = opts.limit ?? 5;
  return deduplicatedHits.slice(0, limit);
}

/**
 * Formats hybrid search hits into a compact context output, hard-capped by character and token budget.
 */
export function formatHybridHitsCompact(
  hits: HybridSearchHit[],
  maxChars = 1600,
  maxTokens = 400,
): string {
  if (hits.length === 0) return 'No relevant memory.';

  const top = hits[0]!.score;
  const out: string[] = [];
  let usedChars = 0;
  const effectiveMaxChars = Math.min(maxChars, maxTokens * 4);

  for (const h of hits) {
    if (h.score < top * 0.25) break;

    const flags: string[] = [];
    if (h.memory.status !== 'active') flags.push(h.memory.status);
    if (h.memory.confidence < 0.9) flags.push(`confidence: ${h.memory.confidence.toFixed(2)}`);
    if (h.memory.supersededBy) flags.push(`superseded by ${h.memory.supersededBy}`);

    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    const entry = `- ${h.memory.title} [${h.memory.type}] .recall/${h.memory.file}${flagStr}${h.excerpt ? `\n  ${h.excerpt}` : ''}`;

    if (out.length > 0 && usedChars + entry.length + 1 > effectiveMaxChars) break;
    out.push(entry.length > effectiveMaxChars ? `${entry.slice(0, effectiveMaxChars - 3)}...` : entry);
    usedChars += entry.length + 1;
  }

  return out.join('\n');
}
