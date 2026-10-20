import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridSearch, extractTechnicalIdentifiers, formatHybridHitsCompact } from '../core/hybrid-retrieval.js';
import type { Memory } from '../core/memory.js';

test('extractTechnicalIdentifiers detects filenames, error codes, and commands', () => {
  const query = 'Fix ERR_AUTH_TIMEOUT in mapper.ts when running npm run build';
  const idfs = extractTechnicalIdentifiers(query);

  assert.ok(idfs.includes('err_auth_timeout'));
  assert.ok(idfs.includes('mapper.ts'));
  assert.ok(idfs.includes('npm run'));
});

test('hybridSearch prioritizes exact matches for error codes and technical identifiers', () => {
  const memories: Memory[] = [
    {
      id: 'mem_001',
      title: 'General Authentication Guidelines',
      body: 'Standard login and session timeout rules for web users.',
      file: 'rules/mem_001.md',
      type: 'convention',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-01-01',
      updated: '2026-01-01',
      tags: ['auth'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
    {
      id: 'mem_002',
      title: 'Troubleshooting ERR_AUTH_TIMEOUT in WebSocket Handshake',
      body: 'When ERR_AUTH_TIMEOUT occurs, increase the heartbeat ping interval in server.ts.',
      file: 'lessons/mem_002.md',
      type: 'lesson',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-09-01',
      updated: '2026-09-01',
      tags: ['websocket', 'error'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'default',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
  ];

  const hits = hybridSearch(memories, 'how to fix ERR_AUTH_TIMEOUT');
  assert.ok(hits.length > 0);
  // ERR_AUTH_TIMEOUT exact match should strongly rank mem_002 at position 0
  assert.equal(hits[0]?.memory.id, 'mem_002');
  assert.ok(hits[0]!.scoreBreakdown.exactMatch > 0);
});

test('formatHybridHitsCompact strictly enforces token / char budget', () => {
  const mockHits = [
    {
      memory: {
        id: 'mem_001',
        title: 'Very long architectural description rule',
        type: 'decision' as const,
        status: 'active' as const,
        confidence: 1.0,
        file: 'decisions/mem_001.md',
      } as Memory,
      score: 10,
      scoreBreakdown: { exactMatch: 5, bm25: 3, vectorSimilarity: 2, recency: 0, confidenceMultiplier: 1.0 },
      excerpt: 'First line of relevant architectural details for this task.',
    },
    {
      memory: {
        id: 'mem_002',
        title: 'Second long architectural rule',
        type: 'convention' as const,
        status: 'active' as const,
        confidence: 0.9,
        file: 'rules/mem_002.md',
      } as Memory,
      score: 8,
      scoreBreakdown: { exactMatch: 4, bm25: 2, vectorSimilarity: 2, recency: 0, confidenceMultiplier: 0.9 },
      excerpt: 'Second line of relevant convention details.',
    },
  ];

  const compact = formatHybridHitsCompact(mockHits, 150);
  assert.ok(compact.length <= 155);
});
