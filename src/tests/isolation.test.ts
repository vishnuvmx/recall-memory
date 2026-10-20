import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadResource, canWriteResource, assertReadAccess, assertWriteAccess } from '../security/isolation.js';
import { hybridSearch } from '../core/hybrid-retrieval.js';
import type { Memory } from '../core/memory.js';
import { RecallError } from '../utils/fs.js';

test('strict cross-tenant isolation blocks reading or writing across tenants', () => {
  const callerTenantA = { tenantId: 'tenant-alpha', workspaceId: 'ws-1', projectId: 'proj-1', role: 'admin' as const };
  const callerTenantB = { tenantId: 'tenant-beta', workspaceId: 'ws-1', projectId: 'proj-1', role: 'admin' as const };

  const memoryTenantA: Partial<Memory> = {
    id: 'mem_001',
    title: 'Secret architectural decision',
    tenantId: 'tenant-alpha',
    workspaceId: 'ws-1',
    visibility: 'workspace',
  };

  assert.equal(canReadResource(callerTenantA, memoryTenantA), true);
  assert.equal(canReadResource(callerTenantB, memoryTenantA), false);
  assert.equal(canWriteResource(callerTenantB, memoryTenantA), false);

  assert.doesNotThrow(() => assertReadAccess(callerTenantA, memoryTenantA));
  assert.throws(() => assertReadAccess(callerTenantB, memoryTenantA), RecallError);
  assert.throws(() => assertWriteAccess(callerTenantB, memoryTenantA), RecallError);
});

test('workspace and user privacy boundaries are strictly enforced', () => {
  const user1 = { tenantId: 'tenant-alpha', workspaceId: 'ws-1', projectId: 'p1', userId: 'alice', role: 'write' as const };
  const user2 = { tenantId: 'tenant-alpha', workspaceId: 'ws-1', projectId: 'p1', userId: 'bob', role: 'write' as const };
  const userOtherWs = { tenantId: 'tenant-alpha', workspaceId: 'ws-2', projectId: 'p1', userId: 'carol', role: 'write' as const };

  // Private memory owned by Alice
  const privateMemory: Partial<Memory> = {
    id: 'mem_002',
    tenantId: 'tenant-alpha',
    workspaceId: 'ws-1',
    userId: 'alice',
    visibility: 'private',
  };

  assert.equal(canReadResource(user1, privateMemory), true);
  assert.equal(canReadResource(user2, privateMemory), false); // Bob cannot see Alice's private memory

  // Workspace-shared memory in WS-1
  const wsMemory: Partial<Memory> = {
    id: 'mem_003',
    tenantId: 'tenant-alpha',
    workspaceId: 'ws-1',
    visibility: 'workspace',
  };

  assert.equal(canReadResource(user1, wsMemory), true);
  assert.equal(canReadResource(user2, wsMemory), true);
  assert.equal(canReadResource(userOtherWs, wsMemory), false); // Carol in WS-2 cannot see WS-1 memory
});

test('hybridSearch enforces multi-tenant boundary and filters out unauthorized memories', () => {
  const memories: Memory[] = [
    {
      id: 'mem_100',
      title: 'Tenant Alpha Database Config',
      body: 'Database connection host: alpha-db.internal',
      file: 'rules/mem_100.md',
      type: 'convention',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-10-01',
      updated: '2026-10-01',
      tags: ['database'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'tenant-alpha',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
    {
      id: 'mem_200',
      title: 'Tenant Beta Database Config',
      body: 'Database connection host: beta-db.internal',
      file: 'rules/mem_200.md',
      type: 'convention',
      status: 'active',
      verification: 'verified',
      confidence: 1.0,
      evidence: [],
      created: '2026-10-01',
      updated: '2026-10-01',
      tags: ['database'],
      sources: [],
      version: 1,
      deprecated: false,
      tenantId: 'tenant-beta',
      workspaceId: 'default',
      projectId: 'default',
      visibility: 'workspace',
    },
  ];

  const searchResultsAlpha = hybridSearch(memories, 'database config', {
    securityContext: { tenantId: 'tenant-alpha', workspaceId: 'default', projectId: 'default', role: 'admin' },
  });

  assert.equal(searchResultsAlpha.length, 1);
  assert.equal(searchResultsAlpha[0]?.memory.id, 'mem_100');
  assert.ok(!searchResultsAlpha.some((h) => h.memory.tenantId === 'tenant-beta'));
});
