import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMemoryStore } from '../core/sqlite-store.js';
import type { Memory } from '../core/memory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('SqliteMemoryStore guarantees immediate read-after-write consistency', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-consistency-test-'));
  const dbPath = path.join(tmpDir, 'consistency.db');
  const store = new SqliteMemoryStore(dbPath);

  try {
    const mem: Memory = {
      id: 'mem_read_after_write',
      title: 'Immediate Consistency Rule',
      body: 'Reads immediately following a write must observe the committed update.',
      file: 'rules/mem_read_after_write.md',
      type: 'convention',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-10-20',
      updated: '2026-10-20',
      tags: ['consistency'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    };

    // Synchronous write
    store.upsertMemorySync(mem);

    // Immediate read
    const fetched = store.getMemory('mem_read_after_write');
    assert.ok(fetched, 'Memory should be immediately retrievable');
    assert.equal(fetched.title, 'Immediate Consistency Rule');

    // Immediate update
    const updatedMem: Memory = { ...mem, title: 'Updated Consistency Rule', version: 2 };
    store.upsertMemorySync(updatedMem);

    // Immediate read of update
    const refetched = store.getMemory('mem_read_after_write');
    assert.equal(refetched?.title, 'Updated Consistency Rule');
    assert.equal(refetched?.version, 2);

    // Immediate FTS BM25 search
    const ftsHits = store.ftsBm25Search('Updated Consistency');
    assert.ok(ftsHits.length > 0);
    assert.equal(ftsHits[0]?.id, 'mem_read_after_write');
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
