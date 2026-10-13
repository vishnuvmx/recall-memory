import fs from 'node:fs';
import path from 'node:path';
import { AGENT_BLOCK, ANTIGRAVITY_RULE, ANTIGRAVITY_SKILL } from '../templates/index.js';
import { RecallError, atomicWrite, resolveInside } from '../utils/fs.js';
import { applyManagedBlock, extractManagedBlock } from '../utils/managed.js';

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

/**
 * Ensures Antigravity-native rule and skill files exist in .agents/
 */
export function syncAntigravitySupport(root: string): void {
  try {
    const agentsDir = resolveInside(root, '.agents');
    const rulesDir = path.join(agentsDir, 'rules');
    const skillDir = path.join(agentsDir, 'skills', 'recall');

    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });

    const rulePath = path.join(rulesDir, 'recall.md');
    if (!fs.existsSync(rulePath)) {
      atomicWrite(rulePath, ANTIGRAVITY_RULE);
    }

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
