import fs from 'node:fs';
import path from 'node:path';

export class RecallError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'RecallError';
  }
}

/** Write via temp file + rename so readers never see partial content. */
export function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Create a file only if it does not exist. Returns false when it already exists. */
export function writeNew(file: string, data: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `parts` under `base`, rejecting traversal and symlink escapes.
 * Works for paths that do not exist yet (checks the deepest existing ancestor).
 */
export function resolveInside(base: string, ...parts: string[]): string {
  const target = path.resolve(base, ...parts);
  if (!isInside(path.resolve(base), target)) {
    throw new RecallError(`Path escapes the allowed directory: ${parts.join('/')}`);
  }
  const realBase = fs.realpathSync(base);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!isInside(realBase, fs.realpathSync(probe))) {
    throw new RecallError(`Path resolves outside the allowed directory via a symlink: ${parts.join('/')}`);
  }
  return target;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
