import fs from 'node:fs';
import path from 'node:path';
import { AGENT_BLOCK, ANTIGRAVITY_RULE, ANTIGRAVITY_SKILL } from '../templates/index.js';
import { RecallError, atomicWrite, resolveInside } from '../utils/fs.js';
import { applyManagedBlock, extractManagedBlock } from '../utils/managed.js';
import { assertNoSecrets } from '../utils/secrets.js';

export type AgentState = 'missing_file' | 'no_block' | 'outdated' | 'installed';

export function agentFilePath(root: string, agentFile: string): string {
  return resolveInside(root, agentFile);
}

export function agentState(root: string, agentFile: string): AgentState {
  const file = agentFilePath(root, agentFile);
  if (!fs.existsSync(file)) return 'missing_file';
  const block = extractManagedBlock(fs.readFileSync(file, 'utf8'));
  if (block === null) return 'no_block';
  return block === AGENT_BLOCK.trim() ? 'installed' : 'outdated';
}

/**
 * If CLAUDE.md exists and agentFile is AGENTS.md, ensure CLAUDE.md imports @AGENTS.md
 */
export function syncClaudeBridge(root: string, agentFile: string): void {
  if (agentFile !== 'AGENTS.md') return;
  try {
    const claudePath = resolveInside(root, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const content = fs.readFileSync(claudePath, 'utf8');
      if (!content.includes('@AGENTS.md') && !content.includes('.recall/')) {
        atomicWrite(claudePath, `${content.trimEnd()}\n\n@AGENTS.md\n`);
      }
    }
  } catch {
    // Non-fatal if symlink or escape check fails
  }
}

export function buildAntigravityRule(recallDir?: string): string {
  let currentStateSnippet = '';
  if (recallDir) {
    const stateFile = path.join(recallDir, 'CURRENT_STATE.md');
    if (fs.existsSync(stateFile)) {
      try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const lines = raw
          .split('\n')
          .filter((l) => !l.startsWith('# Previous Iteration State') && !l.startsWith('> **AI AGENTS**'))
          .map((l) => l.trim())
          .filter(Boolean);

        // Compact files list to max 5 items to preserve prompt token budget (<300 tokens)
        const compactLines: string[] = [];
        let fileCount = 0;
        let inFiles = false;

        for (const line of lines) {
          if (line.startsWith('## Files Modified')) {
            inFiles = true;
            compactLines.push(line);
            continue;
          }
          if (inFiles && line.startsWith('- ')) {
            fileCount++;
            if (fileCount <= 5) {
              compactLines.push(line);
            }
            continue;
          }
          compactLines.push(line);
        }

        if (fileCount > 5) {
          compactLines.push(`- _(+${fileCount - 5} other files)_`);
        }

        if (compactLines.length > 0) {
          currentStateSnippet = compactLines.join('\n');
        }
      } catch {
        // Non-fatal read failure
      }
    }
  }

  let constraintsSnippet = '';
  if (recallDir) {
    const memoryFile = path.join(recallDir, 'MEMORY.md');
    if (fs.existsSync(memoryFile)) {
      try {
        const raw = fs.readFileSync(memoryFile, 'utf8');
        const match = raw.match(/## Critical constraints([\s\S]*?)(?=##|$)/i);
        if (match && match[1]?.trim()) {
          constraintsSnippet = match[1].trim();
        }
      } catch {
        // Non-fatal read failure
      }
    }
  }

  const sections: string[] = [
    '# Recall Invariants & Warm Memory Context',
    '',
  ];

  if (constraintsSnippet) {
    sections.push('## Active Constraints', constraintsSnippet, '');
  }

  if (currentStateSnippet) {
    sections.push('## Current Working State', currentStateSnippet, '');
  }

  sections.push(
    '## Protocol',
    '1. User Request Priority: The user\'s prompt is ALWAYS primary objective #1.',
    '2. Direct Execution: You ALREADY have the warm state above; execute requests directly with full awareness of recent changes.',
    '3. Complex Architecture Tasks: Locate landmark lines via `.recall/PROJECT_MAP.md` or run `recall context "<task>"`.',
    '4. Wrap Up: Run `recall checkpoint "<1-sentence summary>"` before completing responses that modified code across files.',
    '5. Learnings: Save discoveries via `recall propose "<text>" -t "<title>"` (never direct active writes).'
  );

  const block = sections.join('\n').trim();

  // Guard against any accidental secrets entering prompt instructions
  try {
    assertNoSecrets(block);
  } catch {
    return ANTIGRAVITY_RULE.trim();
  }

  return block;
}

/**
 * Ensures Antigravity-native rule and skill files exist in .agents/
 * and keeps the always_on rule warm with current state and constraints,
 * preserving user-added rules outside the managed block.
 */
export function syncAntigravitySupport(root: string, recallDir?: string): void {
  try {
    const targetRecallDir = recallDir ?? (fs.existsSync(path.join(root, '.recall')) ? path.join(root, '.recall') : undefined);
    const agentsDir = resolveInside(root, '.agents');
    const rulesDir = path.join(agentsDir, 'rules');
    const skillDir = path.join(agentsDir, 'skills', 'recall');

    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });

    const rulePath = path.join(rulesDir, 'recall.md');
    const managedContent = buildAntigravityRule(targetRecallDir);

    let existingContent = '';
    if (fs.existsSync(rulePath)) {
      existingContent = fs.readFileSync(rulePath, 'utf8');
    }

    // Ensure frontmatter for Antigravity always_on trigger
    const frontmatter = '---\ntrigger: always_on\n---\n\n';
    let base = existingContent;
    if (!base.includes('trigger:')) {
      base = `${frontmatter}${base}`;
    }

    const updated = applyManagedBlock(base, managedContent);
    atomicWrite(rulePath, updated);

    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      atomicWrite(skillPath, ANTIGRAVITY_SKILL);
    }
  } catch {
    // Non-fatal if .agents cannot be created or is outside boundaries
  }
}

/** Insert or refresh the managed block; existing content outside it is preserved. */
export function installAgentBlock(root: string, agentFile: string): 'created' | 'updated' | 'unchanged' {
  const file = agentFilePath(root, agentFile);
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file, 'utf8') : '';
  const after = applyManagedBlock(before, AGENT_BLOCK);
  if (existed && before === after) {
    syncClaudeBridge(root, agentFile);
    syncAntigravitySupport(root);
    return 'unchanged';
  }
  if (existed && fs.lstatSync(file).isSymbolicLink()) {
    throw new RecallError(`${agentFile} is a symbolic link; refusing to modify it.`);
  }
  atomicWrite(file, after);
  syncClaudeBridge(root, agentFile);
  syncAntigravitySupport(root);
  return existed ? 'updated' : 'created';
}
