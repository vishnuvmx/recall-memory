import type { Memory } from './memory.js';
import type { MemoryType } from '../schemas/index.js';
import type { SecurityContext } from '../security/isolation.js';
import { canReadResource, getSecurityContext } from '../security/isolation.js';
import { isMemoryExpired } from './conflict.js';
import { cosineSimilarity, getOrGenerateEmbedding } from './embeddings.js';
import { stem, stemCandidates, tokenize } from './retrieval.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

export type FusionMode = 'minmax' | 'rrf' | 'raw';

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
  fusionMode?: FusionMode;
  /** Disable 64-dim MD5 feature-hash vector similarity channel. */
  disableVector?: boolean;
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
    expansion?: number;
  };
  excerpt: string;
}

const IDENTIFIER_REGEXES: RegExp[] = [
  // Error codes: ERR_..., SQLITE_..., EEXIST, 404
  /\b[A-Z0-9_]{3,}_[A-Z0-9_]+\b/g,
  /\bE[A-Z]{3,}\b/g,
  // HTTP status codes & common numeric error codes: 401, 403, 404, 429, 500, 502, 503, 504
  /\b(?:40[01349]|422|429|50[0234])\b/g,
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledTokenMatcher {
  token: string;
  exactRe: RegExp;
  stemRes: RegExp[];
  prefixRes: RegExp[];
}

function compileTokenMatcher(token: string): CompiledTokenMatcher {
  const exactRe = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(token)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  const stems = stemCandidates(token);
  const stemRes = stems.map((s) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(s)}(?:$|[^\\p{L}\\p{N}])`, 'iu'));
  const prefixForms = [token, ...stems].filter((s) => s.length >= 4);
  const prefixRes = prefixForms.map((s) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(s)}[\\p{L}\\p{N}]+`, 'iu'));
  return { token, exactRe, stemRes, prefixRes };
}

function matchStrengthInText(text: string, matcher: CompiledTokenMatcher): number {
  if (!text) return 0;
  if (matcher.exactRe.test(text)) return 1.0;
  for (const re of matcher.stemRes) {
    if (re.test(text)) return 0.85;
  }
  for (const re of matcher.prefixRes) {
    if (re.test(text)) return 0.7;
  }
  return 0;
}

/**
 * Corpus-derived query expansion:
 * Discovers tags and high-signal title terms that co-occur with the query's tokens
 * across the user's own active memories (with IDF damping so generic terms don't dominate).
 */
export function expandQueryFromCorpus(memories: Memory[], queryTokens: string[]): Map<string, number> {
  const expanded = new Map<string, number>();
  if (queryTokens.length === 0 || memories.length === 0) return expanded;

  const active = memories.filter((m) => m.status === 'active' && !isMemoryExpired(m));
  if (active.length < 2) return expanded;

  // Document frequency across active memories (tags + title)
  const docFreq = new Map<string, number>();
  const docTermsList: Array<{ tagTokens: string[]; titleTokens: string[] }> = [];

  for (const m of active) {
    const tagTokens = [...new Set(m.tags.flatMap((t) => tokenize(t)))];
    const titleTokens = tokenize(m.title);
    docTermsList.push({ tagTokens, titleTokens });

    const uniqueDocTerms = new Set([...tagTokens, ...titleTokens]);
    for (const term of uniqueDocTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      const st = stem(term);
      if (st !== term) docFreq.set(st, (docFreq.get(st) ?? 0) + 1);
    }
  }

  const N = active.length;
  const queryForms = new Set<string>();
  for (const t of queryTokens) {
    queryForms.add(t);
    queryForms.add(stem(t));
    for (const sc of stemCandidates(t)) queryForms.add(sc);
  }

  const rawAssoc = new Map<string, number>();

  for (const doc of docTermsList) {
    let seedOverlap = 0;
    for (const t of doc.tagTokens) {
      if (queryForms.has(t) || queryForms.has(stem(t))) {
        const qDf = docFreq.get(t) ?? 1;
        // Weight specific query matches (low df) higher than broad verbs
        seedOverlap += 2.5 * Math.log(1 + N / qDf);
      }
    }
    for (const t of doc.titleTokens) {
      if (queryForms.has(t) || queryForms.has(stem(t))) {
        const qDf = docFreq.get(t) ?? 1;
        seedOverlap += 1.0 * Math.log(1 + N / qDf);
      }
    }
    if (seedOverlap === 0) continue;

    // Candidate bridge terms MUST appear in tags (primary) or title (secondary)
    for (const cand of doc.tagTokens) {
      if (queryForms.has(cand) || queryForms.has(stem(cand))) continue;
      rawAssoc.set(cand, (rawAssoc.get(cand) ?? 0) + seedOverlap * 1.8);
    }
    for (const cand of doc.titleTokens) {
      if (queryForms.has(cand) || queryForms.has(stem(cand))) continue;
      rawAssoc.set(cand, (rawAssoc.get(cand) ?? 0) + seedOverlap * 0.6);
    }
  }

  const scored: Array<{ term: string; weight: number }> = [];
  for (const [term, assoc] of rawAssoc.entries()) {
    const df = docFreq.get(term) ?? 1;
    // A bridge term MUST appear in at least 2 memories to connect sibling records,
    // and in at most 35% of the corpus so generic words don't pollute expansion.
    if (df < 2) continue;
    if (N >= 6 && df / N > 0.35) continue;
    const idf = Math.log(1 + N / df);
    scored.push({ term, weight: assoc * idf });
  }

  scored.sort((a, b) => b.weight - a.weight);
  const top = scored.slice(0, 5);
  const maxW = top[0]?.weight ?? 0;
  if (maxW <= 0) return expanded;

  for (const item of top) {
    // Scale expansion weights into [0.35, 0.75] so strong bridge tags bring in sibling memories
    const norm = 0.35 + 0.4 * (item.weight / maxW);
    expanded.set(item.term, norm);
  }
  return expanded;
}

const TYPE_IMPLICIT_VOCAB: Record<MemoryType, string> = {
  bugfix: 'bugfix bug fail fails failed failure error broken fix issue crash hang',
  failed_approach: 'failed approach rejected dead end avoid never',
  design_system: 'design system ui css theme theming color token',
  decision: 'decision architecture choice',
  convention: 'convention rule policy standard invariant',
  lesson: 'lesson learned takeaway',
  fact: 'fact note info',
  task: 'task todo work',
};

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
 * 4. Stem-aware BM25 & field keyword score (FTS5 + word-boundary stem matching)
 * 5. Corpus-derived tag/term co-occurrence query expansion
 * 6. Dense vector similarity + schema type alignment + recency/confidence weighting
 * 7. Configurable score fusion (`minmax` default, `rrf`, or `raw`)
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
  const matchers = tokens.map(compileTokenMatcher);
  const identifiers = extractTechnicalIdentifiers(qTrim);
  const qLower = qTrim.toLowerCase();
  const fusionMode: FusionMode = opts.fusionMode ?? 'minmax';
  // 64-dim MD5 feature-hash vectors are disabled by default after 2-dataset ablation showed
  // 0% Recall@1/Recall@3/MRR gain over Identifier + FTS5 BM25 + Corpus Co-Occurrence.
  // Pass `disableVector: false` explicitly to opt back into the 64-dim MD5 vector channel.
  const useVector = opts.disableVector === false;

  // 1. Precompute query dense embedding only when vector channel is explicitly enabled
  const queryEmbedding = useVector ? getOrGenerateEmbedding(qTrim).vector : null;

  // 2. Corpus-derived query expansion from the user's own active memories
  const expandedMap = expandQueryFromCorpus(memories, tokens);
  const expandedMatchers = [...expandedMap.entries()].map(([term, weight]) => ({
    matcher: compileTokenMatcher(term),
    weight,
  }));

  // 3. Precompute FTS5 BM25 scores if sqlite store is provided
  const ftsScores = new Map<string, number>();
  if (opts.sqliteStore) {
    const hits = opts.sqliteStore.ftsBm25Search(qTrim, 50);
    for (const h of hits) {
      ftsScores.set(h.id, h.bm25Score);
    }
  }

  const now = Date.now();
  interface CandidateFeatures {
    memory: Memory;
    exactScore: number;
    bm25Score: number;
    expansionScore: number;
    vectorScore: number;
    recencyScore: number;
    verificationBonus: number;
    sWeight: number;
    confidenceMultiplier: number;
    excerpt: string;
  }

  const candidates: CandidateFeatures[] = [];

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
    const typeLower = TYPE_IMPLICIT_VOCAB[m.type] ?? m.type;

    // 3. Exact Match Scoring (Identifiers, error codes, filenames, exact phrases)
    let exactScore = 0;
    if (titleLower === qLower) {
      exactScore += 20;
    } else if (qLower.length >= 4 && titleLower.includes(qLower)) {
      exactScore += 10;
    }

    for (const idf of identifiers) {
      if (titleLower.includes(idf)) exactScore += 10;
      else if (tagsLower.includes(idf)) exactScore += 7;
      else if (bodyLower.includes(idf)) exactScore += 5;
    }

    // 4. Corpus-derived Co-occurrence Expansion Score (computed first so we know if domain topic is bridged)
    let expansionScore = 0;
    let expandedTagHits = 0;
    for (const { matcher, weight } of expandedMatchers) {
      const tHit = matchStrengthInText(titleLower, matcher);
      const tagHit = matchStrengthInText(tagsLower, matcher);
      const bHit = matchStrengthInText(bodyLower, matcher);
      const best = Math.max(tHit * 2.5, tagHit * 2.2, bHit * 0.8);
      if (best > 0) {
        expansionScore += best * weight;
        if (tagHit > 0 || tHit > 0) expandedTagHits++;
      }
    }

    // 5. Stem-aware Field & BM25 Keyword Scoring
    let fieldScore = 0;
    let matchedTokenCount = 0;
    let typeMatchedTokens = 0;
    for (const matcher of matchers) {
      const tHit = matchStrengthInText(titleLower, matcher);
      const tagHit = matchStrengthInText(tagsLower, matcher);
      const bHit = matchStrengthInText(bodyLower, matcher);
      const best = Math.max(tHit * 4.0, tagHit * 3.2, bHit * 1.4);
      if (best > 0) {
        fieldScore += best + (tHit > 0 && tagHit > 0 ? 1.2 : 0);
        matchedTokenCount += Math.max(tHit, tagHit, bHit);
      } else {
        // Check if this query token expresses the memory's schema type (e.g., "failure"/"fails" -> type: "bugfix")
        const typeHit = matchStrengthInText(typeLower, matcher);
        if (typeHit > 0) {
          typeMatchedTokens += typeHit;
        }
      }
    }

    // Only credit schema-type token matches when the memory ALSO has a topical match (direct or bridged)
    const hasTopicalSignal = fieldScore > 0 || exactScore > 0 || expandedTagHits >= 2;
    if (hasTopicalSignal && typeMatchedTokens > 0) {
      fieldScore += typeMatchedTokens * 3.2;
      matchedTokenCount += typeMatchedTokens * 0.9;
      if (expandedTagHits >= 2) {
        // Synergy: query combined a bridged domain term (e.g. "login" -> auth/jwt) with a type term (e.g. "failure" -> bugfix)
        fieldScore += expansionScore * 1.25;
      }
    }

    if (matchers.length > 0 && matchedTokenCount > 0) {
      // Coverage bonus when multiple distinct query tokens match the same memory
      fieldScore += (matchedTokenCount / matchers.length) * 4.5;
    }

    const ftsRaw = ftsScores.get(m.id) ?? 0;
    const bm25Score = fieldScore + ftsRaw * 1.2;

    // 6. Dense Vector Similarity (only when enabled)
    let similarity = 0;
    let vectorScore = 0;
    if (useVector && queryEmbedding) {
      const memEmbedding = opts.sqliteStore?.getEmbedding(m.id) ?? getOrGenerateEmbedding(`${m.title}\n${m.body}`).vector;
      similarity = Math.max(0, cosineSimilarity(queryEmbedding, memEmbedding));
      vectorScore = similarity * 6.0;
    }

    // Must have at least some lexical, expanded, or strong vector match to be considered
    if (exactScore === 0 && bm25Score === 0 && expansionScore < 0.8 && (!useVector || similarity < 0.45)) {
      continue;
    }

    let recencyScore = 0;
    try {
      const dateStr = m.updated || m.created;
      const ageDays = (now - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 7) recencyScore += 1.0;
      else if (ageDays <= 30) recencyScore += 0.5;
      else if (ageDays <= 90) recencyScore += 0.2;
    } catch {
      // ignore date parse errors
    }

    const confidenceMultiplier = Math.max(0.1, m.confidence ?? 1.0);
    const verificationBonus = m.verification === 'verified' ? 0.4 : 0;

    const statusWeight: Record<string, number> = {
      active: 1.0,
      proposed: 0.5,
      superseded: 0.2,
      archived: 0.1,
    };
    const sWeight = statusWeight[m.status] ?? 1.0;

    candidates.push({
      memory: m,
      exactScore,
      bm25Score,
      expansionScore,
      vectorScore,
      recencyScore,
      verificationBonus,
      sWeight,
      confidenceMultiplier,
      excerpt: excerptFor(m.body, tokens.concat(identifiers)),
    });
  }

  if (candidates.length === 0) return [];

  // Precompute max values for Min-Max normalization and ranks for RRF
  const maxExact = Math.max(1, ...candidates.map((c) => c.exactScore));
  const maxBm25 = Math.max(1, ...candidates.map((c) => c.bm25Score));
  const maxExpansion = Math.max(2.5, ...candidates.map((c) => c.expansionScore));
  const maxVector = Math.max(1, ...candidates.map((c) => c.vectorScore));

  const rankBy = (getter: (c: CandidateFeatures) => number): Map<string, number> => {
    const sorted = [...candidates].sort((a, b) => getter(b) - getter(a));
    const map = new Map<string, number>();
    sorted.forEach((c, idx) => {
      map.set(c.memory.id, getter(c) > 0 ? idx + 1 : candidates.length + 20);
    });
    return map;
  };

  const exactRanks = fusionMode === 'rrf' ? rankBy((c) => c.exactScore) : undefined;
  const bm25Ranks = fusionMode === 'rrf' ? rankBy((c) => c.bm25Score) : undefined;
  const expRanks = fusionMode === 'rrf' ? rankBy((c) => c.expansionScore) : undefined;
  const vecRanks = fusionMode === 'rrf' ? rankBy((c) => c.vectorScore) : undefined;

  const rawHits: HybridSearchHit[] = [];

  for (const c of candidates) {
    let baseScore = 0;

    if (fusionMode === 'minmax') {
      // Weighted Min-Max normalization preserves relative score magnitude on small corpora
      const normExact = c.exactScore / maxExact;
      const normBm25 = c.bm25Score / maxBm25;
      const normExp = c.expansionScore / maxExpansion;
      const normVec = c.vectorScore / maxVector;

      const normalizedBlend = 14.0 * normExact + 22.0 * normBm25 + 6.0 * normExp + 4.0 * normVec;
      const magnitudeTiebreak = 0.25 * c.exactScore + 0.35 * c.bm25Score + 0.2 * c.expansionScore;
      baseScore = normalizedBlend + magnitudeTiebreak + c.recencyScore + c.verificationBonus;
    } else if (fusionMode === 'rrf') {
      const k = 20;
      const rExact = exactRanks!.get(c.memory.id) ?? 50;
      const rBm25 = bm25Ranks!.get(c.memory.id) ?? 50;
      const rExp = expRanks!.get(c.memory.id) ?? 50;
      const rVec = vecRanks!.get(c.memory.id) ?? 50;

      const rrfScore =
        300 * (1 / (k + rExact)) +
        450 * (1 / (k + rBm25)) +
        150 * (1 / (k + rExp)) +
        100 * (1 / (k + rVec));
      baseScore = rrfScore + c.recencyScore + c.verificationBonus;
    } else {
      baseScore = c.exactScore + c.bm25Score + c.expansionScore + c.vectorScore + c.recencyScore + c.verificationBonus;
    }

    const finalScore = Math.round(baseScore * c.sWeight * c.confidenceMultiplier * 100) / 100;
    if (opts.minScore && finalScore < opts.minScore) continue;

    rawHits.push({
      memory: c.memory,
      score: finalScore,
      scoreBreakdown: {
        exactMatch: c.exactScore,
        bm25: Math.round(c.bm25Score * 100) / 100,
        vectorSimilarity: Math.round(c.vectorScore * 100) / 100,
        recency: c.recencyScore,
        confidenceMultiplier: c.confidenceMultiplier,
        expansion: Math.round(c.expansionScore * 100) / 100,
      },
      excerpt: c.excerpt,
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
