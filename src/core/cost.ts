import fs from 'node:fs';
import path from 'node:path';
import { HOOK_COMMAND, HOOK_NAME } from './agent.js';
import { loadConfig } from './config.js';
import { requireInitialized } from './project.js';
import { extractManagedBlock } from '../utils/managed.js';

/** Rough estimate (~4 chars/token for English/code). Labelled as an estimate everywhere it is shown. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface CostLine {
  source: string;
  tokens: number;
  note?: string;
}

export interface CostReport {
  /** Sent on every agent turn. */
  alwaysOn: CostLine[];
  alwaysOnTotal: number;
  /** Only paid when the agent explicitly reads/calls it. */
  onDemand: CostLine[];
  /** Problems that make Recall cost more than it should (fixed by re-running `recall init`). */
  warnings: string[];
}


function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function costReport(start: string): CostReport {
  const p = requireInitialized(start);
  let agentFile = 'AGENTS.md';
  try {
    agentFile = loadConfig(p.recallDir).agentFile;
  } catch {
    /* surfaced by `recall doctor` */
  }
  const alwaysOn: CostLine[] = [];
  const warnings: string[] = [];

  const agentText = read(path.join(p.root, agentFile));
  const agentBlock = agentText ? extractManagedBlock(agentText) : null;
  alwaysOn.push({ source: `${agentFile} (Recall block only)`, tokens: agentBlock ? estimateTokens(agentBlock) : 0, note: agentBlock ? undefined : 'not installed' });

  const ruleText = read(path.join(p.root, '.agents', 'rules', 'recall.md'));
  const ruleBlock = ruleText ? extractManagedBlock(ruleText) : null;
  if (ruleBlock) {
    alwaysOn.push({ source: '.agents/rules/recall.md (Recall block)', tokens: estimateTokens(ruleBlock) });
    if (agentFile === 'AGENTS.md' || agentFile === 'GEMINI.md') {
      warnings.push('.agents/rules/recall.md duplicates the AGENTS.md instructions (legacy). Run `recall init` to remove it.');
    }
    if (/Current Working State|Previous Progress/.test(ruleBlock)) {
      warnings.push('Always-on rule embeds session state, which changes every session and defeats prompt caching. Run `recall init`.');
    }
  }

  const skillText = read(path.join(p.root, '.agents', 'skills', 'recall', 'SKILL.md'));
  const skillDesc = skillText ? /description:\s*(.*)/.exec(skillText)?.[1] ?? '' : '';
  if (skillText) alwaysOn.push({ source: 'skill name + description', tokens: estimateTokens(`recall ${skillDesc}`) });

  const hooksText = read(path.join(p.root, '.agents', 'hooks.json'));
  if (hooksText) {
    try {
      const hooks = JSON.parse(hooksText) as Record<string, { Stop?: Array<{ command?: string }> }>;
      const cmd = hooks[HOOK_NAME]?.Stop?.[0]?.command;
      if (cmd && cmd !== HOOK_COMMAND) {
        warnings.push(`Checkpoint hook uses an outdated command (\`${cmd}\`) that does not run outside the Recall repo. Run \`recall init\`.`);
      }
    } catch {
      warnings.push('.agents/hooks.json is not valid JSON.');
    }
  }

  const onDemand: CostLine[] = [];
  const addFile = (rel: string, note: string): void => {
    const t = read(path.join(p.recallDir, rel));
    if (t !== null) onDemand.push({ source: `.recall/${rel}`, tokens: estimateTokens(t), note });
  };
  if (skillText) onDemand.push({ source: 'skill body', tokens: estimateTokens(skillText) - estimateTokens(skillDesc), note: 'loaded when the agent picks the skill' });
  onDemand.push({ source: '`recall context` response', tokens: 400, note: 'hard cap' });
  addFile('CURRENT_STATE.md', 'read only for continue/resume');
  addFile('PROJECT_MAP.md', 'for humans; agents use `recall where`');

  return {
    alwaysOn,
    alwaysOnTotal: alwaysOn.reduce((s, l) => s + l.tokens, 0),
    onDemand,
    warnings,
  };
}

