import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { recordCheckpoint } from '../src/core/checkpoint.js';
import { initProject } from '../src/core/init.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const mk = (opts?: { git?: boolean }): string => {
  const d = tmpProject(opts);
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('checkpoint', () => {
  it('updates CURRENT_STATE.md and appends to session log', () => {
    const root = mk({ git: true });
    initProject(root);

    const res = recordCheckpoint(
      root,
      path.join(root, '.recall'),
      'Implemented user authentication with JWT',
      { nextSteps: 'Write integration tests for refresh token' }
    );

    expect(res.summary).toBe('Implemented user authentication with JWT');
    expect(res.nextSteps).toBe('Write integration tests for refresh token');

    const stateFile = path.join(root, '.recall', 'CURRENT_STATE.md');
    expect(fs.existsSync(stateFile)).toBe(true);

    const stateContent = fs.readFileSync(stateFile, 'utf8');
    expect(stateContent).toContain('Implemented user authentication with JWT');
    expect(stateContent).toContain('Write integration tests for refresh token');

    const logFile = path.join(root, '.recall', 'sessions', 'session-log.md');
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, 'utf8');
    expect(logContent).toContain('Implemented user authentication with JWT');

    // Run a second checkpoint
    recordCheckpoint(
      root,
      path.join(root, '.recall'),
      'Added token refresh tests',
      { nextSteps: 'Deploy to staging' }
    );

    const state2 = fs.readFileSync(stateFile, 'utf8');
    expect(state2).toContain('Added token refresh tests');
    expect(state2).not.toContain('Implemented user authentication with JWT'); // Overwritten with latest state

    const log2 = fs.readFileSync(logFile, 'utf8');
    expect(log2).toContain('Implemented user authentication with JWT'); // Preserved in history
    expect(log2).toContain('Added token refresh tests');

    const antigravityRule = path.join(root, '.agents', 'rules', 'recall.md');
    expect(fs.existsSync(antigravityRule)).toBe(true);
    const ruleContent = fs.readFileSync(antigravityRule, 'utf8');
    expect(ruleContent).toContain('Added token refresh tests');
    expect(ruleContent).toContain('Deploy to staging');
    expect(ruleContent).toContain('trigger: always_on');
    expect(ruleContent).toContain('<!-- recall:begin -->');
    expect(ruleContent).toContain('<!-- recall:end -->');

    // Add a custom human-written rule outside the managed block
    fs.writeFileSync(antigravityRule, `${ruleContent}\n\n# Team Invariant\nAlways use strict TypeScript.\n`);

    // Run a third checkpoint and ensure human rule is preserved
    recordCheckpoint(root, path.join(root, '.recall'), 'Fixed login crash');
    const rule3 = fs.readFileSync(antigravityRule, 'utf8');
    expect(rule3).toContain('Fixed login crash');
    expect(rule3).toContain('# Team Invariant\nAlways use strict TypeScript.');

    // Ensure Antigravity hooks.json was created
    const hooksFile = path.join(root, '.agents', 'hooks.json');
    expect(fs.existsSync(hooksFile)).toBe(true);
    const hooksContent = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    expect(hooksContent['recall-session-checkpoint']).toBeDefined();
    expect(hooksContent['recall-session-checkpoint'].Stop).toBeDefined();
  });

  it('prunes session log entries older than 14 days', () => {
    const root = mk({ git: true });
    initProject(root);
    const recallDir = path.join(root, '.recall');
    const logFile = path.join(recallDir, 'sessions', 'session-log.md');

    // Create a mock session log with an old entry from 20 days ago and recent entry from 2 days ago
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    const initialLog = `# Session Log

### [${oldDate}] Checkpoint
- **Summary**: Very old task from 20 days ago
- **Modified**: src/old.ts

### [${recentDate}] Checkpoint
- **Summary**: Recent task from 2 days ago
- **Modified**: src/recent.ts
`;
    fs.mkdirSync(path.join(recallDir, 'sessions'), { recursive: true });
    fs.writeFileSync(logFile, initialLog);

    // Record new checkpoint with default 14-day retention
    recordCheckpoint(root, recallDir, 'Today task');

    const logAfter = fs.readFileSync(logFile, 'utf8');
    expect(logAfter).toContain('Today task');
    expect(logAfter).toContain('Recent task from 2 days ago');
    expect(logAfter).not.toContain('Very old task from 20 days ago'); // Pruned because older than 14 days
  });

  it('prunes previous entries when log exceeds maxEntries', () => {
    const root = mk({ git: true });
    initProject(root);
    const recallDir = path.join(root, '.recall');
    const logFile = path.join(recallDir, 'sessions', 'session-log.md');

    // Record 4 checkpoints with maxEntries = 3
    recordCheckpoint(root, recallDir, 'Task 1', { maxEntries: 3 });
    recordCheckpoint(root, recallDir, 'Task 2', { maxEntries: 3 });
    recordCheckpoint(root, recallDir, 'Task 3', { maxEntries: 3 });
    recordCheckpoint(root, recallDir, 'Task 4', { maxEntries: 3 });

    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).not.toContain('Task 1'); // Oldest pruned because maxEntries = 3
    expect(log).toContain('Task 2');
    expect(log).toContain('Task 3');
    expect(log).toContain('Task 4');
  });

  it('auto-generates summary when omitted or auto option provided', () => {
    const root = mk({ git: true });
    initProject(root);
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
    const recallDir = path.join(root, '.recall');

    // Working directory clean
    const resClean = recordCheckpoint(root, recallDir, undefined, { auto: true });
    expect(resClean.summary).toContain('Session chat iteration completed');

    // Create modified file
    fs.writeFileSync(path.join(root, 'feature.ts'), 'export const a = 1;');
    const resMod = recordCheckpoint(root, recallDir, undefined, { auto: true });
    expect(resMod.summary).toContain('feature.ts');
  });
});
