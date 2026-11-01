import fs from 'node:fs';
import path from 'node:path';
import { installAgentBlock, syncAllAgentIntegrations } from './agent.js';
import { initialCurrentStateMarkdown } from './checkpoint.js';
import { defaultConfig, loadConfig, writeConfig, configPath } from './config.js';
import { rebuildIndex } from './index-builder.js';
import { generateProjectMap } from './mapper.js';
import { loadSearchableMemories } from './memory.js';
import { syncPassport } from './passport.js';
import { findProject, type Project } from './project.js';
import { getSharedSqliteStore } from './sqlite-store.js';
import { CHANGELOG_MD, MEMORY_MD, RULE_TEMPLATES } from '../templates/index.js';
import { writeNew } from '../utils/fs.js';

import { type ProfileTier } from '../schemas/index.js';

export interface InitReport {
  project: Project;
  created: string[];
  skipped: string[];
  agent: 'created' | 'updated' | 'unchanged' | 'skipped';
  agentsSynced?: string[];
}

const DIRS = ['rules', 'decisions', 'lessons', 'tasks', 'sessions', 'logs'];

/** Idempotent scaffolding. Never overwrites user edits, never touches Git. */
export function initProject(
  start: string,
  opts: { agent?: boolean; profile?: ProfileTier; allAgents?: boolean } = {},
): InitReport {
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
    const cfg = defaultConfig();
    if (opts.profile) cfg.profile = opts.profile;
    writeConfig(recallDir, cfg);
    created.push('.recall/config.json');
  }
  put('MEMORY.md', MEMORY_MD);
  put('.gitignore', '# Local ephemeral agent state\n# PROJECT_MAP.md\n# CURRENT_STATE.md\n# sessions/\n.cache/\n');
  for (const [name, text] of Object.entries(RULE_TEMPLATES)) put(`rules/${name}`, text);
  put('logs/CHANGELOG.md', CHANGELOG_MD);
  put('CURRENT_STATE.md', initialCurrentStateMarkdown());
  for (const d of ['decisions', 'lessons', 'tasks', 'sessions']) put(`${d}/.gitkeep`, '');

  const cfg = loadConfig(recallDir);
  const agent = opts.agent === false ? 'skipped' : installAgentBlock(root, cfg.agentFile);
  const agentsSynced = opts.agent !== false && opts.allAgents
    ? syncAllAgentIntegrations(root, { agentFile: cfg.agentFile, createMissing: true })
    : undefined;

  const hadIndex = fs.existsSync(path.join(recallDir, 'INDEX.md'));
  rebuildIndex(recallDir);
  (hadIndex ? skipped : created).push('.recall/INDEX.md');

  const hadPassport = fs.existsSync(path.join(recallDir, 'PASSPORT.md'));
  syncPassport(root, recallDir, { profile: cfg.profile });
  (hadPassport ? skipped : created).push('.recall/PASSPORT.md');

  const hadMap = fs.existsSync(path.join(recallDir, 'PROJECT_MAP.md'));
  generateProjectMap(root, recallDir, cfg.profile);
  (hadMap ? skipped : created).push('.recall/PROJECT_MAP.md');

  try {
    getSharedSqliteStore(recallDir).ensureSynced(loadSearchableMemories(recallDir));
  } catch {
    // Non-fatal fallback when node:sqlite is unavailable
  }

  return {
    project: { ...project, initialized: true },
    created,
    skipped,
    agent,
    ...(agentsSynced ? { agentsSynced } : {}),
  };
}
