import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function tmpProject(opts: { git?: boolean } = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-')));
  if (opts.git) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  }
  return dir;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
