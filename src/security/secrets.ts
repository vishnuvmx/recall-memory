import { RecallError } from '../utils/fs.js';

export interface SecretHit {
  label: string;
  match?: string;
  startIndex?: number;
  endIndex?: number;
}

const REGEX_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['raw private key header', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
  ['AWS secret key', /\baws[_-]?(?:secret|access)[_-]?(?:key)?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi],
  ['OpenAI API key', /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['Anthropic API key', /\bsk-ant-api\d*-[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z\-_]{35}\b/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/g],
  ['Stripe API key', /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['JWT token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ['connection string with credentials', /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s]+:[^@\s]+@[a-zA-Z0-9.-]+/g],
  ['credential assignment', /\b(?:api[_-]?key|secret|token|passwd|password|access_token|refresh_token)\b\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}['"]?/gi],
  ['bearer token', /\bBearer\s+[A-Za-z0-9_\-\.]{24,}\b/gi],
  ['session cookie', /\b(?:connect\.sid|PHPSESSID|JSESSIONID|sessionid)\s*=\s*[A-Za-z0-9_%-]{20,}\b/gi],
];

/**
 * Calculates Shannon entropy of a string (in bits per symbol).
 */
export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const len = str.length;
  const frequencies = new Map<string, number>();

  for (let i = 0; i < len; i++) {
    const char = str[i]!;
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Checks whether a candidate string looks like a standard UUID or common identifier
 * to avoid false positives in entropy scanning.
 */
function isIgnoredToken(token: string): boolean {
  // UUID v4 format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return true;
  }
  // Common long path/filename strings or hashes with prefixes
  if (/^(?:sha256|sha1|md5|git|commit):/i.test(token)) {
    return true;
  }
  // Repeated sequence or single char repeated
  if (/^(.)\1+$/.test(token)) {
    return true;
  }
  return false;
}

/**
 * Scans for high-entropy alphanumeric strings that strongly resemble secret keys or tokens.
 */
export function scanHighEntropySecrets(text: string, minLength = 20, entropyThreshold = 4.3): string[] {
  // Tokenize candidate words (excluding typical markdown links or code syntax punctuation)
  const tokens = text.match(/[A-Za-z0-9/+=_-]{16,}/g) ?? [];
  const hits: string[] = [];

  for (const token of tokens) {
    if (token.length < minLength) continue;
    if (isIgnoredToken(token)) continue;

    const entropy = calculateShannonEntropy(token);
    // Pure hex strings have lower max entropy (log2(16) = 4.0), so adjust threshold for pure hex
    const isHex = /^[0-9a-fA-F]+$/.test(token);
    const threshold = isHex ? 3.75 : entropyThreshold;

    if (entropy >= threshold) {
      hits.push(`high-entropy secret token (${entropy.toFixed(2)} bits/char)`);
    }
  }

  return hits;
}

/**
 * Returns labels of all secret-looking patterns found in text (regex + entropy).
 */
export function findSecrets(text: string): string[] {
  const hits = new Set<string>();

  for (const [label, re] of REGEX_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      hits.add(label);
    }
  }

  const entropyHits = scanHighEntropySecrets(text);
  for (const h of entropyHits) {
    hits.add(h);
  }

  return [...hits];
}

/**
 * Redacts secrets from text, replacing sensitive occurrences with safe placeholder labels.
 */
export function redactSecrets(text: string): { redacted: string; findings: string[] } {
  let redacted = text;
  const findings: string[] = [];

  for (const [label, re] of REGEX_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    let hasMatch = false;

    // Redact regex matches
    redacted = redacted.replace(re, (matched) => {
      hasMatch = true;
      return `[REDACTED_SECRET:${label.toUpperCase().replace(/\s+/g, '_')}]`;
    });

    if (hasMatch) {
      findings.push(label);
    }
  }

  // Redact remaining high entropy tokens
  redacted = redacted.replace(/[A-Za-z0-9/+=_-]{20,}/g, (token) => {
    if (isIgnoredToken(token)) return token;
    const isHex = /^[0-9a-fA-F]+$/.test(token);
    const threshold = isHex ? 3.75 : 4.3;
    if (calculateShannonEntropy(token) >= threshold) {
      findings.push('high-entropy token');
      return '[REDACTED_HIGH_ENTROPY_TOKEN]';
    }
    return token;
  });

  return { redacted, findings: [...new Set(findings)] };
}

/**
 * Enforces secret-free text before persisting. Throws RecallError if any secret pattern is found.
 */
export function assertNoSecrets(text: string): void {
  const hits = findSecrets(text);
  if (hits.length > 0) {
    throw new RecallError(
      `Refusing to store content that looks like a secret (${hits.join(', ')}).`,
      'Remove credentials and describe them instead (e.g. "API key lives in the env var RECALL_API_KEY").',
    );
  }
}
