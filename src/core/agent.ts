import fs from 'node:fs';
import path from 'node:path';
import { AGENT_BLOCK, ANTIGRAVITY_SKILL_BODY, LEGACY_SKILL_MARKER, SKILL_FRONTMATTER } from '../templates/index.js';
import { RecallError, atomicWrite, resolveInside } from '../utils/fs.js';
import { applyManagedBlock, extractManagedBlock, removeManagedBlock } from '../utils/managed.js';

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

/** Agent files Antigravity already loads as always-on rules. Writing a rule file too would double the cost. */
const NATIVELY_LOADED = new Set(['AGENTS.md', 'GEMINI.md']);

export const HOOK_NAME = 'recall-session-checkpoint';
/**
 * Runs via `sh -c` / `cmd /c` from the `.agents/` directory (Antigravity hook spec), so it must be a
 * plain PATH command with no shell operators or repo-relative paths. `--hook` prints `{}` (valid hook
 * JSON) and never fails the agent loop.
 */
export const HOOK_COMMAND = 'recall checkpoint --hook';

function writeIfChanged(file: string, content: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  atomicWrite(file, content);
}

/**
 * Keep `.agents/rules/recall.md` from duplicating the agent file. Older versions wrote a dynamic,
 * always-on copy of the protocol there; remove it (keeping any human-written rules).
 */
function syncRuleFile(rulesDir: string, agentFile: string): void {
  const rulePath = path.join(rulesDir, 'recall.md');
  const existing = fs.existsSync(rulePath) ? fs.readFileSync(rulePath, 'utf8') : null;

  if (NATIVELY_LOADED.has(agentFile)) {
    if (existing === null) return;
    const stripped = removeManagedBlock(existing);
    const leftover = stripped.replace(/^---[\s\S]*?---\s*/, '').trim();
    if (!leftover) fs.rmSync(rulePath);
    else if (stripped !== existing) atomicWrite(rulePath, stripped);
    return;
  }

  // Custom agent file that Antigravity may not read: install the same static block as a rule.
  fs.mkdirSync(rulesDir, { recursive: true });
  const base = existing && existing.includes('trigger:') ? existing : `---\ntrigger: always_on\n---\n\n${existing ?? ''}`;
  writeIfChanged(rulePath, applyManagedBlock(base, AGENT_BLOCK));
}

/** On-demand skill. Generated content lives in a managed block; user-customized skills are left alone. */
function syncSkill(skillDir: string): void {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const fresh = `${SKILL_FRONTMATTER}\n\n${applyManagedBlock('', ANTIGRAVITY_SKILL_BODY)}`;
  if (!fs.existsSync(skillPath)) {
    fs.mkdirSync(skillDir, { recursive: true });
    atomicWrite(skillPath, fresh);
    return;
  }
  const existing = fs.readFileSync(skillPath, 'utf8');
  if (extractManagedBlock(existing) !== null) {
    // Refresh frontmatter description too, since it is the only always-visible part of a skill.
    const body = existing.replace(/^---[\s\S]*?---\s*/, '');
    writeIfChanged(skillPath, `${SKILL_FRONTMATTER}\n\n${applyManagedBlock(body, ANTIGRAVITY_SKILL_BODY)}`);
  } else if (existing.includes(LEGACY_SKILL_MARKER)) {
    atomicWrite(skillPath, fresh); // written by an older Recall version; safe to migrate
  }
}

function syncHook(agentsDir: string): void {
  const hooksPath = path.join(agentsDir, 'hooks.json');
  let hooks: Record<string, unknown> = {};
  if (fs.existsSync(hooksPath)) {
    try {
      hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return; // never clobber a hand-edited hooks.json we cannot parse
    }
  }
  hooks[HOOK_NAME] = { Stop: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }] };
  writeIfChanged(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
}

/**
 * Antigravity integration: static content only. Nothing here depends on session state, so repeated
 * calls are byte-stable and never invalidate prompt caches.
 */
export function syncAntigravitySupport(root: string, agentFile = 'AGENTS.md'): void {
  try {
    const agentsDir = resolveInside(root, '.agents');
    syncRuleFile(path.join(agentsDir, 'rules'), agentFile);
    syncSkill(path.join(agentsDir, 'skills', 'recall'));
    syncHook(agentsDir);
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
    syncAntigravitySupport(root, agentFile);
    return 'unchanged';
  }
  if (existed && fs.lstatSync(file).isSymbolicLink()) {
    throw new RecallError(`${agentFile} is a symbolic link; refusing to modify it.`);
  }
  atomicWrite(file, after);
  syncClaudeBridge(root, agentFile);
  syncAntigravitySupport(root, agentFile);
  return existed ? 'updated' : 'created';
}
