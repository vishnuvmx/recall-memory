import { spawnSync } from 'node:child_process';

export interface GitInfo {
  available: boolean;
  isRepo: boolean;
}

function run(args: string[], cwd: string): { ok: boolean; out: string } {
  // --no-optional-locks keeps status strictly read-only (no index refresh writes).
  const r = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return { ok: false, out: '' };
  return { ok: true, out: r.stdout };
}

export function gitInfo(cwd: string): GitInfo {
  const v = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (v.error || v.status !== 0) return { available: false, isRepo: false };
  const r = run(['rev-parse', '--is-inside-work-tree'], cwd);
  return { available: true, isRepo: r.ok && r.out.trim() === 'true' };
}

/** Uncommitted changes limited to the .recall path only. */
export function recallChanges(root: string, recallRel = '.recall'): string[] | null {
  const r = run(['status', '--porcelain', '--', recallRel], root);
  if (!r.ok) return null;
  return r.out.split('\n').filter(Boolean);
}

/** Uncommitted changed file paths across the repository (excluding .recall). */
export function repoChanges(root: string): string[] | null {
  const r = run(['status', '--porcelain', '-uall'], root);
  if (!r.ok) return null;
  const files: string[] = [];
  for (const line of r.out.split('\n')) {
    if (!line || line.length < 4) continue;
    // Porcelain v1 format is: XY <path> or XY <orig> -> <new>
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) {
      p = p.split(' -> ')[1]!.trim();
    }
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1);
    }
    const normalized = p.replace(/\\/g, '/');
    if (!normalized.startsWith('.recall/') && normalized !== '.recall') {
      files.push(normalized);
    }
  }
  return [...new Set(files)];
}

export interface Commit {
  hash: string;
  date: string;
  subject: string;
}

/** Committed history for .recall only. Returns null when unavailable. */
export function recallHistory(root: string, limit: number, recallRel = '.recall'): Commit[] | null {
  const r = run(['log', `-n${limit}`, '--format=%h%x09%ad%x09%s', '--date=short', '--', recallRel], root);
  if (!r.ok) return null;
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash = '', date = '', ...rest] = l.split('\t');
      return { hash, date, subject: rest.join('\t') };
    });
}

export interface UndoResult {
  ok: boolean;
  message: string;
  dryRun?: boolean;
  restored?: string[];
  cleaned?: string[];
}

/** Revert all uncommitted changes and delete untracked files in .recall/ (never touches gitignored files) */
export function undoRecall(root: string, recallRel = '.recall', opts: { dryRun?: boolean } = {}): UndoResult {
  const info = gitInfo(root);
  if (!info.isRepo) {
    return { ok: false, message: 'Not inside a Git repository. Cannot revert via Git.' };
  }

  const diffWorktree = run(['diff', '--name-only', '--', recallRel], root).out.split('\n').filter(Boolean);
  const diffStaged = run(['diff', '--cached', '--name-only', '--', recallRel], root).out.split('\n').filter(Boolean);
  const tracked = [...new Set([...diffWorktree, ...diffStaged])];

  const cleanDry = run(['clean', '-nd', '--', recallRel], root).out.split('\n').filter(Boolean)
    .map((l) => l.replace(/^Would remove\s+/, ''));

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      message: `[dry-run] Would restore ${tracked.length} tracked file(s) and delete ${cleanDry.length} untracked file(s). Gitignored files are never touched.`,
      restored: tracked,
      cleaned: cleanDry,
    };
  }

  // 1. Restore tracked changes (both staged and worktree)
  const hasHead = run(['rev-parse', '--verify', 'HEAD'], root).ok;
  if (hasHead) {
    let res = run(['restore', '--staged', '--worktree', '--', recallRel], root);
    if (!res.ok) {
      run(['reset', 'HEAD', '--', recallRel], root);
      run(['checkout', '--', recallRel], root);
    }
  } else {
    run(['rm', '--cached', '-r', '-f', '--quiet', '--', recallRel], root);
  }
  // 2. Remove untracked files and directories within .recall/
  const cleanRes = run(['clean', '-fd', '--', recallRel], root);
  if (!cleanRes.ok) {
    return { ok: false, message: `Failed to clean untracked files in ${recallRel}.` };
  }
  return {
    ok: true,
    message: `Reverted all uncommitted changes and removed untracked files in ${recallRel}. Gitignored files were untouched.`,
    restored: tracked,
    cleaned: cleanDry,
  };
}
