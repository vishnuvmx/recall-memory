import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts, isMemoryExpired } from '../core/conflict.js';
import { hybridSearch } from '../core/hybrid-retrieval.js';
import type { Memory } from '../core/memory.js';

test('detectConflicts identifies contradictory architectural guidelines', () => {
  const existing: Memory[] = [
    {
      id: 'mem_010',
      title: 'Use REST API for external integration',
      body: 'Always use REST JSON APIs for partner integrations.',
      file: 'decisions/mem_010.md',
      type: 'decision',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-01-01',
      updated: '2026-01-01',
      tags: ['api'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
  ];

  const candidate = {
    title: 'Use REST API for external integration',
    text: 'Do not use REST API. Partner integrations are deprecated and replaced by GraphQL.',
    type: 'decision' as const,
  };

  const conflict = detectConflicts(existing, candidate);
  assert.equal(conflict.hasConflict, true);
  assert.equal(conflict.conflictingMemories.length, 1);
  assert.equal(conflict.conflictingMemories[0]?.id, 'mem_010');
});

test('isMemoryExpired correctly checks expiration dates', () => {
  const activeMemory: Memory = {
    id: 'mem_020',
    title: 'Temporary flag for migration',
    body: 'Feature flag is active during October 2026 migration window.',
    file: 'decisions/mem_020.md',
    type: 'decision',
    status: 'active',
    verification: 'verified',
    confidence: 1.0,
    evidence: [],
    created: '2026-10-01',
    updated: '2026-10-01',
    expiresAt: '2026-10-15',
    tags: [],
    sources: [],
    version: 1,
    deprecated: false,
    tenantId: 'default',
    workspaceId: 'default',
    projectId: 'default',
    visibility: 'workspace',
  };

  assert.equal(isMemoryExpired(activeMemory, '2026-10-20'), true);
  assert.equal(isMemoryExpired(activeMemory, '2026-10-10'), false);
});

test('expired and superseded memories are excluded from active hybrid search', () => {
  const memories: Memory[] = [
    {
      id: 'mem_old',
      title: 'Legacy Auth Strategy',
      body: 'Use basic auth for all endpoints.',
      file: 'decisions/mem_old.md',
      type: 'decision',
      status: 'superseded',
      supersededBy: 'mem_new',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-01-01',
      updated: '2026-01-01',
      tags: ['auth'],
      sources: [],
      version: 1,
      deprecated: true,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
    {
      id: 'mem_new',
      title: 'OAuth2 Authentication Strategy',
      body: 'Use OAuth2 Bearer tokens for all endpoints.',
      file: 'decisions/mem_new.md',
      type: 'decision',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-09-01',
      updated: '2026-09-01',
      tags: ['auth'],
      sources: [],
      version: 2,
      deprecated: false,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
  ];

  const hits = hybridSearch(memories, 'authentication strategy');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.memory.id, 'mem_new');
});
