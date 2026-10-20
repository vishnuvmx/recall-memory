import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../mcp/server.js';
import { authenticateRequest, checkAuthorization } from '../security/auth.js';
import { RecallError } from '../utils/fs.js';

test('authenticateRequest validates token and origins correctly', () => {
  const config = {
    enabled: true,
    tokens: {
      'valid-secret-token': {
        role: 'admin' as const,
        tenantId: 'tenant-1',
        workspaceId: 'ws-1',
      },
      'read-only-token': {
        role: 'read' as const,
        tenantId: 'tenant-1',
        workspaceId: 'ws-1',
      },
    },
    allowedOrigins: ['localhost', '127.0.0.1'],
  };

  // Missing token
  const authMissing = authenticateRequest(undefined, undefined, config);
  assert.equal(authMissing.authenticated, false);

  // Invalid token
  const authInvalid = authenticateRequest('wrong-token', undefined, config);
  assert.equal(authInvalid.authenticated, false);

  // Valid token
  const authValid = authenticateRequest('valid-secret-token', undefined, config);
  assert.equal(authValid.authenticated, true);
  assert.equal(authValid.context.tenantId, 'tenant-1');
  assert.equal(authValid.context.role, 'admin');

  // Forbidden origin
  const authBadOrigin = authenticateRequest('valid-secret-token', 'http://malicious.evil.com', config);
  assert.equal(authBadOrigin.authenticated, false);
});

test('checkAuthorization enforces role boundaries', () => {
  const readContext = { tenantId: 't', workspaceId: 'w', projectId: 'p', role: 'read' as const };
  const writeContext = { tenantId: 't', workspaceId: 'w', projectId: 'p', role: 'write' as const };

  // Read context can read
  assert.doesNotThrow(() => checkAuthorization(readContext, 'read'));

  // Read context cannot write
  assert.throws(() => checkAuthorization(readContext, 'write'), RecallError);

  // Write context can write
  assert.doesNotThrow(() => checkAuthorization(writeContext, 'write'));
});

test('handleMessage rejects unauthenticated requests when auth is enabled', () => {
  process.env.RECALL_AUTH_REQUIRED = '1';
  process.env.RECALL_AUTH_TOKEN = 'secret-mcp-key';

  try {
    const unauthenticatedMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'recall_context',
        arguments: { query: 'test' },
      },
    };

    const res = handleMessage(process.cwd(), unauthenticatedMsg);
    assert.ok(res);
    assert.ok(res.error, 'Expected error for unauthenticated call');
    assert.equal((res.error as { code: number }).code, -32001);

    // Call with correct token
    const authenticatedMsg = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'recall_context',
        token: 'secret-mcp-key',
        arguments: { query: 'test' },
      },
    };

    const authRes = handleMessage(process.cwd(), authenticatedMsg);
    assert.ok(authRes);
    assert.equal((authRes as { error?: unknown }).error, undefined);
  } finally {
    delete process.env.RECALL_AUTH_REQUIRED;
    delete process.env.RECALL_AUTH_TOKEN;
  }
});
