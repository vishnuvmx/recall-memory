import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findSecrets,
  assertNoSecrets,
  redactSecrets,
  calculateShannonEntropy,
  scanHighEntropySecrets,
} from '../security/secrets.js';
import { RecallError } from '../utils/fs.js';

test('findSecrets detects API keys, tokens, and private keys', () => {
  const samples = [
    { text: 'sk-proj-abc1234567890123456789012345', label: 'OpenAI API key' },
    { text: 'AKIAIOSFODNN7EXAMPLE', label: 'AWS access key' },
    { text: 'ghp_123456789012345678901234567890123456', label: 'GitHub token' },
    { text: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', label: 'JWT token' },
    { text: 'postgres://admin:SuperSecretPass123!@db.internal:5432/prod', label: 'connection string' },
    { text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----', label: 'private key' },
  ];

  for (const s of samples) {
    const hits = findSecrets(s.text);
    assert.ok(hits.length > 0, `Expected secret detected for: ${s.text}`);
    assert.throws(() => assertNoSecrets(s.text), RecallError);
  }
});

test('calculateShannonEntropy accurately identifies high-entropy random keys', () => {
  const lowEntropy = 'This is a normal English sentence about software engineering.';
  const highEntropy = '9f8a3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c';
  const randomBase64 = 'kR8+mN4/vL2pQ9xZ1wY6tF3bJ7sD0hG=';

  const lowH = calculateShannonEntropy(lowEntropy);
  const highH = calculateShannonEntropy(highEntropy);
  const b64H = calculateShannonEntropy(randomBase64);

  assert.ok(lowH < 3.8, `Expected low entropy for English, got ${lowH}`);
  assert.ok(highH >= 3.7, `Expected high entropy for hex, got ${highH}`);
  assert.ok(b64H >= 4.3, `Expected high entropy for base64, got ${b64H}`);

  const secretsFound = scanHighEntropySecrets(`api_secret = "${randomBase64}"`);
  assert.ok(secretsFound.length > 0);
});

test('redactSecrets replaces credentials with redaction markers', () => {
  const textWithSecrets = 'Connect with postgres://user:secretpassword@db.com:5432 and key sk-proj-1234567890123456789012345.';
  const result = redactSecrets(textWithSecrets);

  assert.ok(!result.redacted.includes('secretpassword'));
  assert.ok(!result.redacted.includes('sk-proj-1234567890123456789012345'));
  assert.ok(result.redacted.includes('[REDACTED_SECRET:'));
  assert.ok(result.findings.length >= 2);
});

test('clean technical notes pass assertNoSecrets without false positives', () => {
  const safeDoc = 'The auth token is passed in the Authorization header as a Bearer token. Store the key in RECALL_API_KEY environment variable.';
  assert.doesNotThrow(() => assertNoSecrets(safeDoc));
});
