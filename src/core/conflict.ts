import { updateMemory, type Memory, type NewMemory } from './memory.js';
import { stem, tokenize } from './retrieval.js';
import { today } from '../utils/fs.js';

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictingMemories: Memory[];
  suggestedAction: 'supersede' | 'merge' | 'review' | 'none';
  warnings: string[];
}

/**
 * Checks whether a memory has expired based on its `expiresAt` or `validUntil` date.
 */
export function isMemoryExpired(memory: Memory, checkDate = today()): boolean {
  if (!memory.expiresAt) return false;
  return memory.expiresAt < checkDate;
}

/**
 * Marks an existing memory as superseded by a newer memory.
 */
export function supersedeMemory(recallDir: string, oldId: string, newId: string, reason?: string): Memory {
  const note = reason || `Superseded by newer knowledge in ${newId}`;
  return updateMemory(recallDir, oldId, {
    status: 'superseded',
    supersededBy: newId,
    deprecated: true,
    deprecatedReason: note,
  });
}

/**
 * Explicitly marks a memory as deprecated.
 */
export function deprecateMemory(recallDir: string, id: string, reason: string): Memory {
  return updateMemory(recallDir, id, {
    deprecated: true,
    deprecatedReason: reason,
    status: 'archived',
  });
}

const NEGATION_RE = /\b(?:do\s+not|don't|never|avoid|forbid|prohibit|disable|disallow|ban|stop\s+using)\b/i;
const REPLACEMENT_RE =
  /\b(?:instead\s+of|no\s+longer|replaced\s+by|replace\s+with|migrated?\s+(?:from|to)|switched?\s+(?:from|to)|deprecated?|supersedes?|dropped)\b/i;

function extractStemSet(text: string, tags: string[] = []): Set<string> {
  const set = new Set<string>();
  for (const t of tokenize(`${text} ${tags.join(' ')}`)) {
    set.add(stem(t));
  }
  return set;
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  return (2 * inter) / (a.size + b.size);
}

/**
 * Detects whether an incoming memory potentially contradicts or replaces existing memories.
 * Flags conflicts as non-blocking `'review'` warnings rather than silently overwriting or superseding.
 */
export function detectConflicts(existingMemories: Memory[], candidate: NewMemory): ConflictCheckResult {
  const candTitle = candidate.title.toLowerCase().trim();
  const candText = candidate.text.toLowerCase().trim();
  const candCombined = `${candTitle}\n${candText}`;
  const candTopicStems = extractStemSet(candidate.title, candidate.tags);
  const candAllStems = extractStemSet(`${candidate.title} ${candidate.text}`, candidate.tags);

  const hasCandNegation = NEGATION_RE.test(candCombined);
  const hasCandReplacement = REPLACEMENT_RE.test(candCombined);

  const conflicting: Memory[] = [];
  const warnings: string[] = [];

  for (const m of existingMemories) {
    if (m.status !== 'active' || isMemoryExpired(m)) continue;

    const mTitle = m.title.toLowerCase().trim();
    const mText = m.body.toLowerCase().trim();
    const mCombined = `${mTitle}\n${mText}`;

    const memTopicStems = extractStemSet(m.title, m.tags);
    const memAllStems = extractStemSet(`${m.title} ${m.body}`, m.tags);

    const topicSim = diceSimilarity(candTopicStems, memTopicStems);
    const fullSim = diceSimilarity(candAllStems, memAllStems);

    const hasMemNegation = NEGATION_RE.test(mCombined);

    // 1. Direct negation reversal on a shared topic ("Never use X" vs "Use X")
    const isNegationReversal =
      hasCandNegation !== hasMemNegation && (topicSim >= 0.35 || (topicSim >= 0.2 && fullSim >= 0.35));

    // 2. Replacement / migration / deprecation phrase on a shared topic ("Switch from REST to GraphQL" vs "API uses REST")
    const isReplacementConflict =
      hasCandReplacement && (topicSim >= 0.25 || fullSim >= 0.3);

    // 3. Classic direct title inclusion with contradiction keywords
    const isDirectContradiction =
      (candText.includes('do not use') && mText.includes('use ') && candTitle.includes(mTitle)) ||
      (mText.includes('do not use') && candText.includes('use ') && mTitle.includes(candTitle)) ||
      (candText.includes('deprecated') && mTitle === candTitle) ||
      (candText.includes('replaced by') && candTitle === mTitle);

    if (isNegationReversal || isReplacementConflict || isDirectContradiction) {
      conflicting.push(m);
      const reason = isReplacementConflict
        ? 'mentions replacement/migration on the same topic'
        : 'opposing directive on the same topic';
      warnings.push(
        `Possible conflict with ${m.id} "${m.title}" (.recall/${m.file}): ${reason}. Review and run \`recall archive ${m.id}\` if superseded.`,
      );
    }
  }

  return {
    hasConflict: conflicting.length > 0,
    conflictingMemories: conflicting,
    suggestedAction: conflicting.length > 0 ? 'review' : 'none',
    warnings,
  };
}
