import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteMemoryStore } from '../core/sqlite-store.js';
import { AsyncWriteQueue, withRetry } from '../core/write-queue.js';
import type { Memory } from '../core/memory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('AsyncWriteQueue safely serializes parallel asynchronous operations', async () => {
  const queue = new AsyncWriteQueue();
  const executionOrder: number[] = [];

  const promises = [
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 40));
      executionOrder.push(1);
      return 1;
    }),
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push(2);
      return 2;
    }),
    queue.enqueue(async () => {
      executionOrder.push(3);
      return 3;
    }),
  ];

  const results = await Promise.all(promises);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(executionOrder, [1, 2, 3]);
});

test('SqliteMemoryStore handles rapid concurrent writes in WAL mode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-sqlite-concurrency-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new SqliteMemoryStore(dbPath);

  try {
    const memoryCount = 25;
    const writePromises: Promise<void>[] = [];

    for (let i = 0; i < memoryCount; i++) {
      const mem: Memory = {
        id: `mem_${String(i).padStart(3, '0')}`,
        title: `Concurrent memory item ${i}`,
        body: `Body content for item ${i} with critical notes.`,
        file: `decisions/mem_${String(i).padStart(3, '0')}.md`,
        type: 'decision',
        status: 'active',
        verification: 'verified',
        confidence: 1.0,
        evidence: [],
        created: '2026-10-20',
        updated: '2026-10-20',
        tags: [`tag_${i}`],
        sources: [],
        version: 1,
        deprecated: false,
        tenantId: 'default',
        workspaceId: 'default',
        projectId: 'default',
        visibility: 'workspace',
      };

      writePromises.push(store.upsertMemory(mem));
    }

    // All concurrent promises should resolve successfully without SQLITE_BUSY or locking errors
    await Promise.all(writePromises);

    const all = store.getAllMemories();
    assert.equal(all.length, memoryCount);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('withRetry handles transient simulated lock errors', async () => {
  let attempts = 0;
  const flakeyOp = async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error('database is locked (SQLITE_BUSY)');
    }
    return 'success';
  };

  const result = await withRetry(flakeyOp, 5, 10);
  assert.equal(result, 'success');
  assert.equal(attempts, 3);
});
