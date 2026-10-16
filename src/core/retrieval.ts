import type { MemoryType } from '../schemas/index.js';
import type { Memory } from './memory.js';

export interface SearchOptions {
  limit?: number;
  includeProposed?: boolean;
  includeArchived?: boolean;
  type?: MemoryType;
  tag?: string;
  minScore?: number;
}

export interface SearchHit {
  memory: Memory;
  score: number;
  excerpt: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was',
  'how', 'why', 'what', 'when', 'should', 'can', 'could', 'would', 'will',
  'have', 'has', 'had', 'been', 'about', 'each', 'more', 'some', 'than',
  'them', 'then', 'they', 'does', 'did', 'done', 'also', 'such',
]);

export function stemCandidates(word: string): string[] {
  const s = word.toLowerCase();
  const cands = new Set<string>();

  if (s.endsWith('ing') && s.length > 4) {
    const base = s.slice(0, -3);
    cands.add(base);
    cands.add(`${base}e`);
    if (/(.)\1$/.test(base)) {
      cands.add(base.slice(0, -1));
    }
  } else if (s.endsWith('ies') && s.length > 4) {
    cands.add(s.slice(0, -3) + 'y');
  } else if (s.endsWith('es') && s.length > 4) {
    cands.add(s.slice(0, -2));
    cands.add(s.slice(0, -1));
  } else if (s.endsWith('ed') && s.length > 4) {
    const base = s.slice(0, -2);
    cands.add(base);
    cands.add(`${base}e`);
    if (/(.)\1$/.test(base)) {
      cands.add(base.slice(0, -1));
    }
  } else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) {
    cands.add(s.slice(0, -1));
  }

  return [...cands].filter((c) => c.length > 2 && c !== s);
}

export function stem(word: string): string {
  const c = stemCandidates(word);
  return c[0] ?? word.toLowerCase();
}

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = raw.filter((t) => t.length > 1 && !STOP.has(t));
  return [...new Set(words)];
}

function headings(body: string): string {
  return body
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .join(' ')
    .toLowerCase();
}

function hasWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

function excerptFor(body: string, tokens: string[]): string {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !/^#{1,6}\s/.test(l));
  const hit = lines.find((l) => tokens.some((t) => hasWord(l.toLowerCase(), t))) ?? lines[0] ?? '';
  return hit.length > 220 ? `${hit.slice(0, 217)}...` : hit;
}

const STATUS_WEIGHT = { active: 1, proposed: 0.5, superseded: 0.3, archived: 0.1 } as const;

interface TokenMatcher {
  token: string;
  wordRe: RegExp;
  prefixRe: RegExp;
  countRe: RegExp;
  stemRes: Array<{ wordRe: RegExp; prefixRe: RegExp }>;
}

function buildMatcher(token: string): TokenMatcher {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  const prefixRe = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}[\\p{L}\\p{N}]*`, 'iu');
  const countRe = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'giu');
  const stemRes = stemCandidates(token).map((st) => {
    const escSt = st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      wordRe: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escSt}(?:$|[^\\p{L}\\p{N}])`, 'iu'),
      prefixRe: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escSt}[\\p{L}\\p{N}]*`, 'iu'),
    };
  });
  return { token, wordRe, prefixRe, countRe, stemRes };
}

/** Deterministic keyword search. This is NOT semantic search. */
export function search(memories: Memory[], query: string, opts: SearchOptions = {}): SearchHit[] {
  const tokens = tokenize(query);
  const phrase = query.trim().toLowerCase();
  if (tokens.length === 0) return [];
  const matchers = tokens.map(buildMatcher);
  const hits: SearchHit[] = [];

  const now = Date.now();
  for (const m of memories) {
    if (m.status === 'archived' && !opts.includeArchived) continue;
    if (m.status === 'proposed' && !opts.includeProposed) continue;
    if (opts.type && m.type !== opts.type) continue;
    if (opts.tag && !m.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) continue;

    const title = m.title.toLowerCase();
    const tags = m.tags.join(' ').toLowerCase();
    const heads = headings(m.body);
    const body = m.body.toLowerCase();
    let score = 0;
    let matched = 0;
    if (title === phrase) score += 15;
    else if (title.includes(phrase)) score += 8;

    for (const mtr of matchers) {
      let s = 0;
      if (mtr.wordRe.test(title)) s += 3;
      else if (mtr.stemRes.some((sr) => sr.wordRe.test(title) || sr.prefixRe.test(title))) s += 2;

      if (mtr.wordRe.test(tags)) s += 2;
      else if (mtr.stemRes.some((sr) => sr.wordRe.test(tags) || sr.prefixRe.test(tags))) s += 1.5;

      if (mtr.wordRe.test(heads)) s += 2;
      else if (mtr.stemRes.some((sr) => sr.wordRe.test(heads) || sr.prefixRe.test(heads))) s += 1.5;

      const matches = body.match(mtr.countRe);
      const c = matches ? matches.length : 0;
      if (c > 0) s += Math.min(c, 3);
      else if (mtr.stemRes.some((sr) => sr.wordRe.test(body) || sr.prefixRe.test(body))) s += 1;

      if (s > 0) matched++;
      score += s;
    }
    if (matched === 0) continue;
    if (tokens.length > 1) score += (matched / tokens.length) * 5;
    if (m.verification === 'verified') score += 0.5;

    // Recency bonus: recent memories are slightly more relevant
    try {
      const dateStr = m.updated || m.created;
      const ageDays = (now - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 14) score += 0.2;
      else if (ageDays <= 30) score += 0.1;
    } catch {
      // ignore invalid dates
    }

    score *= STATUS_WEIGHT[m.status];
    const finalScore = Math.round(score * 100) / 100;
    if (opts.minScore && finalScore < opts.minScore) continue;
    hits.push({ memory: m, score: finalScore, excerpt: excerptFor(m.body, tokens) });
  }
  hits.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
  return hits.slice(0, opts.limit ?? 5);
}
