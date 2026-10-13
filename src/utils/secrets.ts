import { RecallError } from './fs.js';

const PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['API key (sk-...)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Google API key', /\bAIza[0-9A-Za-z\-_]{35,}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/],
  ['Stripe API key', /\b[rs]k_(live|test)_[0-9a-zA-Z]{24,}\b/],
  ['JWT token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/],
  ['connection string with credentials', /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s]+:[^@\s]+@[a-zA-Z0-9.-]+/],
  ['credential assignment', /\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}/i],
];

/** Returns the labels of any secret-looking patterns (never the matched text). */
export function findSecrets(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export function assertNoSecrets(text: string): void {
  const hits = findSecrets(text);
  if (hits.length > 0) {
    throw new RecallError(
      `Refusing to store content that looks like a secret (${hits.join(', ')}).`,
      'Remove the credential and describe it instead (e.g. "API key lives in the env var X").',
    );
  }
}
