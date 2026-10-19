import { RecallError } from './fs.js';

/** Replace (or append) a marker-delimited block, preserving everything outside it. */
export function applyManagedBlock(existing: string, block: string, name = 'recall'): string {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const wrapped = `${begin}\n${block.trim()}\n${end}`;
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b === -1 && e === -1) {
    if (existing.trim() === '') return `${wrapped}\n`;
    return `${existing.replace(/\s*$/, '')}\n\n${wrapped}\n`;
  }
  if (b === -1 || e === -1 || e < b || existing.indexOf(begin, b + 1) !== -1) {
    throw new RecallError(
      `Malformed Recall markers (${name}). Refusing to modify the file.`,
      `Fix or remove the "${begin}" / "${end}" lines manually, then retry.`,
    );
  }
  return existing.slice(0, b) + wrapped + existing.slice(e + end.length);
}

export function extractManagedBlock(existing: string, name = 'recall'): string | null {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b === -1 || e === -1 || e < b) return null;
  return existing.slice(b + begin.length, e).trim();
}

/** Remove a marker-delimited block (and its markers), preserving everything else. No-op if absent. */
export function removeManagedBlock(existing: string, name = 'recall'): string {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const b = existing.indexOf(begin);
  const e = existing.indexOf(end);
  if (b === -1 || e === -1 || e < b) return existing;
  const before = existing.slice(0, b).replace(/\s*$/, '');
  const after = existing.slice(e + end.length).replace(/^\s*/, '');
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}
