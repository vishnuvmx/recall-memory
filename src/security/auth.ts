import crypto from 'node:crypto';
import { RecallError } from '../utils/fs.js';
import type { SecurityContext } from './isolation.js';

export interface AuthConfig {
  enabled: boolean;
  tokens: Record<string, { role: 'admin' | 'write' | 'read'; tenantId: string; workspaceId: string; userId?: string }>;
  allowedOrigins: string[];
}

export interface AuthResult {
  authenticated: boolean;
  context: SecurityContext;
  error?: string;
}

/**
 * Loads default auth settings from environment or config.
 */
export function getAuthConfig(): AuthConfig {
  const envToken = process.env.RECALL_AUTH_TOKEN;
  const enabled = !!envToken || process.env.RECALL_AUTH_REQUIRED === '1';
  const tokens: AuthConfig['tokens'] = {};

  if (envToken) {
    tokens[envToken] = {
      role: (process.env.RECALL_ROLE as 'admin' | 'write' | 'read') || 'admin',
      tenantId: process.env.RECALL_TENANT_ID || 'default',
      workspaceId: process.env.RECALL_WORKSPACE_ID || 'default',
      userId: process.env.RECALL_USER_ID,
    };
  }

  const allowedOrigins = (process.env.RECALL_ALLOWED_ORIGINS || 'localhost,127.0.0.1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { enabled, tokens, allowedOrigins };
}

/**
 * Validates origin header for network/RPC requests.
 */
export function validateOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true; // stdio or local process without origin header
  try {
    const url = new URL(origin.startsWith('http') ? origin : `http://${origin}`);
    const host = url.hostname.toLowerCase();
    return allowedOrigins.some((allowed) => {
      const a = allowed.toLowerCase();
      return host === a || host.endsWith(`.${a}`);
    });
  } catch {
    return false;
  }
}

/**
 * Authenticates an incoming request (bearer token, header, or query param).
 */
export function authenticateRequest(
  token: string | undefined,
  origin: string | undefined,
  config = getAuthConfig(),
): AuthResult {
  // 1. Origin check
  if (!validateOrigin(origin, config.allowedOrigins)) {
    return {
      authenticated: false,
      context: { tenantId: 'unknown', workspaceId: 'unknown', projectId: 'unknown', role: 'read' },
      error: `Forbidden origin: ${origin}`,
    };
  }

  // 2. If auth is not required, allow with default security context
  if (!config.enabled) {
    return {
      authenticated: true,
      context: {
        tenantId: process.env.RECALL_TENANT_ID || 'default',
        workspaceId: process.env.RECALL_WORKSPACE_ID || 'default',
        projectId: process.env.RECALL_PROJECT_ID || 'default',
        userId: process.env.RECALL_USER_ID,
        role: 'admin',
      },
    };
  }

  // 3. Auth is enabled: token must match
  if (!token) {
    return {
      authenticated: false,
      context: { tenantId: 'unknown', workspaceId: 'unknown', projectId: 'unknown', role: 'read' },
      error: 'Authentication token missing.',
    };
  }

  // Use timing-safe comparison to prevent timing attacks
  const tokenRecord = Object.entries(config.tokens).find(([validToken]) => {
    if (validToken.length !== token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(validToken), Buffer.from(token));
    } catch {
      return false;
    }
  });

  if (!tokenRecord) {
    return {
      authenticated: false,
      context: { tenantId: 'unknown', workspaceId: 'unknown', projectId: 'unknown', role: 'read' },
      error: 'Invalid authentication token.',
    };
  }

  const [, details] = tokenRecord;
  return {
    authenticated: true,
    context: {
      tenantId: details.tenantId,
      workspaceId: details.workspaceId,
      projectId: process.env.RECALL_PROJECT_ID || 'default',
      userId: details.userId,
      role: details.role,
    },
  };
}

/**
 * Enforces permission check for a tool or operation.
 */
export function checkAuthorization(context: SecurityContext, requiredRole: 'admin' | 'write' | 'read'): void {
  const roleRank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  const currentRank = roleRank[context.role || 'read'] ?? 1;
  const targetRank = roleRank[requiredRole] ?? 1;

  if (currentRank < targetRank) {
    throw new RecallError(
      `Unauthorized: Role "${context.role}" lacks required "${requiredRole}" privilege.`,
      'Provide an authorized token with write/admin privileges.',
    );
  }
}
