import fs from 'node:fs';
import path from 'node:path';
import { installAgentBlock } from './agent.js';
import { initialCurrentStateMarkdown } from './checkpoint.js';
import { defaultConfig, loadConfig, writeConfig, configPath } from './config.js';
import { rebuildIndex } from './index-builder.js';
import { generateProjectMap } from './mapper.js';
import { findProject, type Project } from './project.js';
import { CHANGELOG_MD, MEMORY_MD, RULE_TEMPLATES } from '../templates/index.js';
import { writeNew } from '../utils/fs.js';

export interface InitReport {
  project: Project;
  created: string[];
  skipped: string[];
  agent: 'created' | 'updated' | 'unchanged' | 'skipped';
}

const DIRS = ['rules', 'decisions', 'lessons', 'tasks', 'sessions', 'logs'];

/** Idempotent scaffolding. Never overwrites, never touches Git, never reads source files. */
export function initProject(start: string, opts: { agent?: boolean } = {}): InitReport {
  const project = findProject(start);
  const { recallDir, root } = project;
  const created: string[] = [];
  const skipped: string[] = [];
  const put = (rel: string, content: string): void => {
    (writeNew(path.join(recallDir, rel), content) ? created : skipped).push(`.recall/${rel}`);
  };

  fs.mkdirSync(recallDir, { recursive: true });
  for (const d of DIRS) fs.mkdirSync(path.join(recallDir, d), { recursive: true });

  if (fs.existsSync(configPath(recallDir))) {
    loadConfig(recallDir); // fail loudly on a malformed config rather than overwrite it
    skipped.push('.recall/config.json');
  } else {
    writeConfig(recallDir, defaultConfig());
    created.push('.recall/config.json');
  }
  put('MEMORY.md', MEMORY_MD);
  put('.gitignore', '# Local ephemeral agent state (optional; un-comment to prevent PR merge conflicts)\n# PROJECT_MAP.md\n# CURRENT_STATE.md\n# sessions/\n');
  for (const [name, text] of Object.entries(RULE_TEMPLATES)) put(`rules/${name}`, text);
  put('logs/CHANGELOG.md', CHANGELOG_MD);
  put('CURRENT_STATE.md', initialCurrentStateMarkdown());
  for (const d of ['decisions', 'lessons', 'tasks', 'sessions']) put(`${d}/.gitkeep`, '');

  const cfg = loadConfig(recallDir);
  const agent = opts.agent === false ? 'skipped' : installAgentBlock(root, cfg.agentFile);

  const hadMap = fs.existsSync(path.join(recallDir, 'PROJECT_MAP.md'));
  generateProjectMap(root, recallDir);
  (hadMap ? skipped : created).push('.recall/PROJECT_MAP.md');

  const hadIndex = fs.existsSync(path.join(recallDir, 'INDEX.md'));
  rebuildIndex(recallDir);
  (hadIndex ? skipped : created).push('.recall/INDEX.md');

  return { project: { ...project, initialized: true }, created, skipped, agent };
}
