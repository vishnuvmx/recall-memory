import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, tmpProject } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

const dirs: string[] = [];
const mk = (opts?: { git?: boolean }): string => {
  const d = tmpProject(opts);
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

function runRecall(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('cli e2e', () => {
  it('executes recall init and recall status cleanly', () => {
    const root = mk({ git: true });
    const initRes = runRecall(['init'], root);
    expect(initRes.status).toBe(0);
    expect(initRes.stdout).toContain('Project root:');
    expect(initRes.stdout).toContain('created  .recall/config.json');

    const statusRes = runRecall(['status'], root);
    expect(statusRes.status).toBe(0);
    expect(statusRes.stdout).toContain('Initialized: yes');
    expect(statusRes.stdout).toContain('Index: up_to_date');
  });

  it('saves memory, searches with context, and approves proposals', () => {
    const root = mk({ git: true });
    runRecall(['init'], root);

    const memRes = runRecall(['remember', 'Keep UI pure without side effects', '-t', 'Pure UI components', '--active'], root);
    expect(memRes.status).toBe(0);
    expect(memRes.stdout).toContain('Saved mem_001 (fact, active, unverified)');

    const searchRes = runRecall(['context', 'pure UI'], root);
    expect(searchRes.status).toBe(0);
    expect(searchRes.stdout).toContain('Pure UI components');

    const docRes = runRecall(['doctor'], root);
    expect(docRes.status).toBe(0);
    expect(docRes.stdout).toContain('memory files: 1 valid memories');
  });

  it('safeguards undo against untracked memory loss without --force', () => {
    const root = mk({ git: true });
    runRecall(['init'], root);
    runRecall(['remember', 'Draft lesson before commit', '-t', 'Draft note'], root);

    const memoryFilesBefore = fs.readdirSync(path.join(root, '.recall', 'rules')).filter((f) => f.startsWith('mem_'));
    expect(memoryFilesBefore.length).toBeGreaterThan(0);

    // Running undo without --force or --dry-run must fail safely
    const unsafeRes = runRecall(['undo'], root);
    expect(unsafeRes.status).not.toBe(0);
    expect(unsafeRes.stderr).toContain('undo would delete');
    expect(unsafeRes.stderr).toContain('--force');

    // Verify files on disk were NOT deleted
    const memoryFilesAfter = fs.readdirSync(path.join(root, '.recall', 'rules')).filter((f) => f.startsWith('mem_'));
    expect(memoryFilesAfter).toEqual(memoryFilesBefore);

    // Running undo with --force succeeds and deletes untracked memory files
    const forceRes = runRecall(['undo', '--force'], root);
    expect(forceRes.status).toBe(0);
    expect(forceRes.stdout).toContain('Reverted all uncommitted changes');

    const rulesDir = path.join(root, '.recall', 'rules');
    const memoryFilesAfterForce = fs.existsSync(rulesDir)
      ? fs.readdirSync(rulesDir).filter((f) => f.startsWith('mem_'))
      : [];
    expect(memoryFilesAfterForce).toHaveLength(0);
  });
});
