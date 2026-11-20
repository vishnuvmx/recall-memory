import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
export const LEGACY_HOOK_COMMAND = 'recall checkpoint --hook';

const SELF_CLI_PATH = fileURLToPath(new URL('../cli/index.js', import.meta.url));

/**
 * Resolves the Recall CLI entry script (`dist/cli/index.js`) or binary when executed from `.agents/`
 * or any subdirectory of a project, without assuming `recall` is globally installed in OS PATH.
 */
export function resolveRecallCliPath(
  startDir: string = process.cwd(),
  opts: { cliPathOverride?: string; allowGlobalPath?: boolean } = {},
): string | null {
  const override = opts.cliPathOverride !== undefined ? opts.cliPathOverride : process.env.RECALL_CLI_PATH;
  if (override !== undefined) {
    return override && fs.existsSync(override) ? path.resolve(override) : null;
  }

  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const candidates = [
      path.join(dir, 'node_modules', '@vishnuvmx', 'recall-memory', 'dist', 'cli', 'index.js'),
      path.join(dir, 'node_modules', 'recall-memory', 'dist', 'cli', 'index.js'),
      path.join(dir, 'dist', 'cli', 'index.js'),
    ];
    const hintFile = path.join(dir, '.recall', '.cache', 'cli-path.txt');
    if (fs.existsSync(hintFile)) {
      try {
        const hinted = fs.readFileSync(hintFile, 'utf8').trim();
        if (hinted) candidates.push(hinted);
      } catch {
        // ignore unreadable hint file
      }
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (opts.allowGlobalPath !== false) {
    try {
      const probe = spawnSync('recall', ['--version'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
        timeout: 3000,
      });
      if (probe.status === 0) return 'recall';
    } catch {
      // global binary not found
    }
  }

  return null;
}

/**
 * Cross-platform self-resolving hook command.
 * Antigravity executes hooks via `sh -c` / `cmd /c` with CWD set to `.agents/`.
 * This inline Node bootstrap walks up from `.agents/` to locate the project's local Recall CLI
 * (`node_modules`, `dist/cli/index.js`, or `.recall/.cache/cli-path.txt`), falls back to global
 * `recall` if present, and gracefully outputs `{}` (exit 0) if the executable is missing.
 */
export const HOOK_COMMAND =
  `node -e "const fs=require('fs'),path=require('path'),cp=require('child_process');const envCli=process.env.RECALL_CLI_PATH;let cli='';if(typeof envCli==='string'){if(envCli&&fs.existsSync(envCli))cli=envCli;}else{let d=process.cwd();for(let i=0;i<6;i++){const cands=[path.join(d,'node_modules','@vishnuvmx','recall-memory','dist','cli','index.js'),path.join(d,'node_modules','recall-memory','dist','cli','index.js'),path.join(d,'dist','cli','index.js')];const hint=path.join(d,'.recall','.cache','cli-path.txt');if(fs.existsSync(hint)){try{const hp=fs.readFileSync(hint,'utf8').trim();if(hp)cands.push(hp);}catch{}}const hit=cands.find(p=>fs.existsSync(p));if(hit){cli=hit;break;}const p=path.dirname(d);if(p===d)break;d=p;}}if(cli){const r=cp.spawnSync(process.execPath,[cli,'checkpoint','--hook'],{stdio:['inherit','pipe','ignore'],encoding:'utf8'});process.stdout.write((r.stdout||'').trim()||'{}');}else if(typeof envCli==='undefined'){const r=cp.spawnSync('recall',['checkpoint','--hook'],{stdio:['inherit','pipe','ignore'],encoding:'utf8',shell:process.platform==='win32'});process.stdout.write(r.status===0&&(r.stdout||'').trim()?r.stdout.trim():'{}');}else{process.stdout.write('{}');}"`;

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
  const handler = { type: 'command', command: HOOK_COMMAND, timeout: 15 };
  hooks[HOOK_NAME] = {
    SessionStart: [handler],
    Stop: [handler],
  };
  writeIfChanged(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
}

function isRecallHookCommand(cmd?: string): boolean {
  return cmd === HOOK_COMMAND || cmd === LEGACY_HOOK_COMMAND;
}

function syncClaudeHook(root: string, createMissing = false): boolean {
  try {
    const claudeDir = resolveInside(root, '.claude');
    if (!createMissing && !fs.existsSync(claudeDir)) return false;
    fs.mkdirSync(claudeDir, { recursive: true });

    // Prefer settings.json if already present, otherwise settings.local.json
    const settingsPath = fs.existsSync(path.join(claudeDir, 'settings.json'))
      ? path.join(claudeDir, 'settings.json')
      : path.join(claudeDir, 'settings.local.json');

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return false; // never clobber hand-edited settings we cannot parse
      }
    }

    const hooksObj = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown>;
    for (const eventName of ['SessionStart', 'Stop']) {
      const eventArr = Array.isArray(hooksObj[eventName]) ? (hooksObj[eventName] as Array<Record<string, unknown>>) : [];
      let found = false;
      for (const entry of eventArr) {
        const inner = Array.isArray(entry?.hooks) ? (entry.hooks as Array<{ command?: string; type?: string; timeout?: number }>) : [];
        for (const h of inner) {
          if (isRecallHookCommand(h.command)) {
            h.command = HOOK_COMMAND;
            found = true;
          }
        }
      }

      if (!found) {
        eventArr.push({
          hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 15 }],
        });
      }
      hooksObj[eventName] = eventArr;
    }
    settings.hooks = hooksObj;
    writeIfChanged(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function syncCursorHook(root: string, createMissing = false): boolean {
  try {
    const cursorDir = resolveInside(root, '.cursor');
    if (!createMissing && !fs.existsSync(cursorDir)) return false;
    fs.mkdirSync(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, 'hooks.json');
    let parsed: Record<string, unknown> = { version: 1, hooks: {} };
    if (fs.existsSync(hooksPath)) {
      try {
        parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    if (!parsed.version) parsed.version = 1;
    const hooksObj = (parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : {}) as Record<string, unknown>;
    const stopList = Array.isArray(hooksObj.stop) ? (hooksObj.stop as Array<{ command?: string }>) : [];
    let found = false;
    for (const h of stopList) {
      if (isRecallHookCommand(h.command)) {
        h.command = HOOK_COMMAND;
        found = true;
      }
    }
    if (!found) {
      stopList.push({ command: HOOK_COMMAND });
    }
    hooksObj.stop = stopList;
    parsed.hooks = hooksObj;
    writeIfChanged(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronizes instructions and Stop hooks across all AI coding agents so switching models
 * never loses context or forgets to checkpoint normal chats.
 */
export function syncAllAgentIntegrations(
  root: string,
  opts: { agentFile?: string; createMissing?: boolean } = {},
): string[] {
  const agentFile = opts.agentFile ?? 'AGENTS.md';
  const createMissing = !!opts.createMissing;
  const synced: string[] = [];

  // 1. Primary instruction file (AGENTS.md is natively read by Antigravity, Codex, Cursor, Windsurf, Cline, Aider, Zed)
  installAgentBlock(root, agentFile);
  synced.push(agentFile);

  // 2. Antigravity (.agents/skills + .agents/hooks.json)
  syncAntigravitySupport(root, agentFile);
  synced.push('.agents/hooks.json');

  // 3. Claude Code (CLAUDE.md + .claude Stop hook)
  try {
    const claudeMd = resolveInside(root, 'CLAUDE.md');
    if (createMissing && !fs.existsSync(claudeMd) && agentFile === 'AGENTS.md') {
      atomicWrite(claudeMd, '@AGENTS.md\n');
      synced.push('CLAUDE.md');
    } else if (fs.existsSync(claudeMd)) {
      syncClaudeBridge(root, agentFile);
      synced.push('CLAUDE.md');
    }
  } catch {
    // ignore
  }
  if (syncClaudeHook(root, createMissing)) {
    synced.push('.claude/hooks');
  }

  // 4. Cursor (.cursor/hooks.json)
  if (syncCursorHook(root, createMissing)) {
    synced.push('.cursor/hooks.json');
  }

  // 5. Windsurf & GitHub Copilot instruction bridges (only if present or createMissing)
  for (const extraFile of ['.windsurfrules', '.github/copilot-instructions.md']) {
    try {
      const p = resolveInside(root, ...extraFile.split('/'));
      if (!createMissing && !fs.existsSync(p)) continue;
      const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      writeIfChanged(p, applyManagedBlock(before, AGENT_BLOCK));
      synced.push(extraFile);
    } catch {
      // ignore
    }
  }

  return synced;
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

    const recallDir = path.join(root, '.recall');
    if (fs.existsSync(recallDir) && fs.existsSync(SELF_CLI_PATH)) {
      const cliHintPath = path.join(recallDir, '.cache', 'cli-path.txt');
      writeIfChanged(cliHintPath, `${SELF_CLI_PATH}\n`);
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
    syncClaudeHook(root, false);
    syncCursorHook(root, false);
    syncAntigravitySupport(root, agentFile);
    return 'unchanged';
  }
  if (existed && fs.lstatSync(file).isSymbolicLink()) {
    throw new RecallError(`${agentFile} is a symbolic link; refusing to modify it.`);
  }
  atomicWrite(file, after);
  syncClaudeBridge(root, agentFile);
  syncClaudeHook(root, false);
  syncCursorHook(root, false);
  syncAntigravitySupport(root, agentFile);
  return existed ? 'updated' : 'created';
}
