import { findMemory, updateMemory, type Memory, type NewMemory } from './memory.js';
import { today } from '../utils/fs.js';

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictingMemories: Memory[];
  suggestedAction: 'supersede' | 'merge' | 'review' | 'none';
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

/**
 * Detects whether an incoming memory contradicts or conflicts with existing memories.
 */
export function detectConflicts(existingMemories: Memory[], candidate: NewMemory): ConflictCheckResult {
  const candTitle = candidate.title.toLowerCase().trim();
  const candText = candidate.text.toLowerCase().trim();
  const candType = candidate.type || 'fact';

  const conflicting: Memory[] = [];

  for (const m of existingMemories) {
    if (m.status !== 'active') continue;
    if (m.type !== candType) continue;

    const mTitle = m.title.toLowerCase().trim();
    const mText = m.body.toLowerCase().trim();

    // Check for direct contradiction patterns:
    // e.g. "Do not use X" vs "Use X", "Avoid Y" vs "Always use Y", "Deprecated Z" vs "Implemented Z"
    const isDirectContradiction =
      (candText.includes('do not use') && mText.includes('use ') && candTitle.includes(mTitle)) ||
      (mText.includes('do not use') && candText.includes('use ') && mTitle.includes(candTitle)) ||
      (candText.includes('deprecated') && mTitle === candTitle) ||
      (candText.includes('replaced by') && candTitle === mTitle);

    if (isDirectContradiction) {
      conflicting.push(m);
    }
  }

  return {
    hasConflict: conflicting.length > 0,
    conflictingMemories: conflicting,
    suggestedAction: conflicting.length > 0 ? 'supersede' : 'none',
  };
}
