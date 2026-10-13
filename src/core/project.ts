import fs from 'node:fs';
import path from 'node:path';
import { RecallError, resolveInside } from '../utils/fs.js';

export interface Project {
  /** Directory that contains (or will contain) `.recall/`. */
  root: string;
  recallDir: string;
  initialized: boolean;
  /** How the root was found. */
  source: 'recall' | 'git' | 'cwd';
}

export const RECALL_DIR = '.recall';

function walkUp(start: string, test: (dir: string) => boolean): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest Recall config first, then nearest Git root, then the start directory. */
export function findProject(start: string = process.cwd()): Project {
  const recallRoot = walkUp(start, (d) => fs.existsSync(path.join(d, RECALL_DIR, 'config.json')));
  if (recallRoot) {
    return { root: recallRoot, recallDir: path.join(recallRoot, RECALL_DIR), initialized: true, source: 'recall' };
  }
  const gitRoot = walkUp(start, (d) => fs.existsSync(path.join(d, '.git')));
  const root = gitRoot ?? path.resolve(start);
  return { root, recallDir: path.join(root, RECALL_DIR), initialized: false, source: gitRoot ? 'git' : 'cwd' };
}

export function requireInitialized(start?: string): Project {
  const p = findProject(start);
  if (!p.initialized) {
    throw new RecallError('Recall is not initialized in this project.', 'Run `recall init` first.');
  }
  // Refuse a .recall that is a symlink pointing elsewhere.
  resolveInside(p.root, RECALL_DIR);
  return p;
}
