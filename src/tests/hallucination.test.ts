import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../core/memory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('low-confidence memories are quarantined into proposed status for review', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-hallucinate-test-'));

  try {
    fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });

    // High confidence memory (e.g. 0.95) lands active
    const memHigh = createMemory(tmpDir, {
      title: 'Verified Database Index Strategy',
      text: 'Always index foreign keys in PostgreSQL.',
      confidence: 0.95,
      evidence: ['https://postgresql.org/docs/index'],
    });

    assert.equal(memHigh.status, 'active');
    assert.equal(memHigh.confidence, 0.95);
    assert.equal(memHigh.evidence[0], 'https://postgresql.org/docs/index');

    // Low confidence memory (e.g. 0.45 - inferred preference or hallucinated claim)
    const memLow = createMemory(tmpDir, {
      title: 'Inferred preference for Tabs over Spaces',
      text: 'User seemed to prefer 4 spaces based on one snippet.',
      confidence: 0.45,
      evidence: [],
    });

    // Must be forced to 'proposed' and 'needs_review'
    assert.equal(memLow.status, 'proposed');
    assert.equal(memLow.verification, 'needs_review');
    assert.equal(memLow.confidence, 0.45);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
