import fs from 'node:fs';
import path from 'node:path';
import { agentState } from './agent.js';
import { loadConfig } from './config.js';
import { gitInfo, recallChanges } from './git.js';
import { brokenIndexLinks, indexState } from './index-builder.js';
import { loadAll } from './memory.js';
import { findProject } from './project.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const REQUIRED = ['rules', 'decisions', 'lessons', 'tasks', 'sessions', 'logs'];

export function runDoctor(start: string): Check[] {
  const p = findProject(start);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string): void => {
    checks.push({ name, ok, detail, ...(fix ? { fix } : {}) });
  };
  add('project root', true, `${p.root} (found via ${p.source})`);
  if (!p.initialized) {
    add('initialized', false, 'No .recall/config.json found.', 'Run `recall init`.');
    return checks;
  }
  let agentFile = 'AGENTS.md';
  try {
    agentFile = loadConfig(p.recallDir).agentFile;
    add('config', true, '.recall/config.json is valid');
  } catch (err) {
    add('config', false, (err as Error).message, 'Fix .recall/config.json or `git checkout -- .recall/config.json`.');
  }
  for (const d of REQUIRED) {
    const ok = fs.existsSync(path.join(p.recallDir, d));
    if (!ok) add(`directory ${d}/`, false, 'missing', `Run \`recall init\` (safe to repeat) or mkdir .recall/${d}`);
  }
  for (const f of ['MEMORY.md', 'INDEX.md', 'PROJECT_MAP.md', 'CURRENT_STATE.md']) {
    const ok = fs.existsSync(path.join(p.recallDir, f));
    if (!ok) {
      let fix = 'Run `recall init`.';
      if (f === 'INDEX.md') fix = 'Run `recall rebuild`.';
      if (f === 'PROJECT_MAP.md') fix = 'Run `recall map`.';
      add(f, false, 'missing', fix);
    }
  }
  const loaded = loadAll(p.recallDir);
  if (loaded.problems.length === 0) add('memory files', true, `${loaded.memories.length} valid memories`);
  for (const pr of loaded.problems) add(`memory ${pr.file}`, false, pr.error, 'Edit the file to fix its frontmatter. Recall will not delete it.');
  const state = indexState(p.recallDir);
  add('index', state === 'up_to_date', state, state === 'up_to_date' ? undefined : 'Run `recall rebuild`.');
  const broken = brokenIndexLinks(p.recallDir);
  if (broken.length > 0) add('index links', false, `broken: ${broken.join(', ')}`, 'Run `recall rebuild` or fix hand-written links.');
  try {
    const a = agentState(p.root, agentFile);
    add('agent instructions', a === 'installed', `${agentFile}: ${a}`, a === 'installed' ? undefined : 'Run `recall init` to install/refresh the managed block.');
  } catch (err) {
    add('agent instructions', false, (err as Error).message);
  }
  const g = gitInfo(p.root);
  add('git', g.available, g.available ? (g.isRepo ? 'repository detected' : 'git installed, but not inside a repository') : 'git not installed (history features reduced)');
  if (g.isRepo) {
    const ch = recallChanges(p.root);
    add('uncommitted recall changes', true, ch ? `${ch.length} path(s)` : 'unknown');
  }
  return checks;
}
