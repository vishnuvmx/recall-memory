import fs from 'node:fs';
import path from 'node:path';
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
  });
});
