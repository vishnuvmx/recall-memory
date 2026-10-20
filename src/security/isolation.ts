import { RecallError } from '../utils/fs.js';

export type MemoryVisibility = 'private' | 'workspace' | 'public';

export interface SecurityContext {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  userId?: string;
  role?: 'admin' | 'write' | 'read';
}

export interface IsolatedResource {
  tenantId?: string;
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  visibility?: MemoryVisibility;
}

export const DEFAULT_CONTEXT: SecurityContext = {
  tenantId: 'default',
  workspaceId: 'default',
  projectId: 'default',
  role: 'admin',
};

/**
 * Builds a SecurityContext, falling back to process env or defaults.
 */
export function getSecurityContext(overrides?: Partial<SecurityContext>): SecurityContext {
  return {
    tenantId: overrides?.tenantId || process.env.RECALL_TENANT_ID || 'default',
    workspaceId: overrides?.workspaceId || process.env.RECALL_WORKSPACE_ID || 'default',
    projectId: overrides?.projectId || process.env.RECALL_PROJECT_ID || 'default',
    userId: overrides?.userId || process.env.RECALL_USER_ID,
    role: overrides?.role || (process.env.RECALL_ROLE as SecurityContext['role']) || 'admin',
  };
}

/**
 * Validates whether a given caller security context can read a resource.
 */
export function canReadResource(caller: SecurityContext, resource: IsolatedResource): boolean {
  // Tenant boundaries are strictly isolated: no resource from tenant A can ever be seen by tenant B
  const resourceTenant = resource.tenantId || 'default';
  if (caller.tenantId !== resourceTenant) {
    return false;
  }

  const visibility: MemoryVisibility = resource.visibility || 'workspace';

  // Public: visible to all callers in the same tenant
  if (visibility === 'public') {
    return true;
  }

  // Workspace: visible to callers in the same workspace
  if (visibility === 'workspace') {
    const resourceWorkspace = resource.workspaceId || 'default';
    return caller.workspaceId === resourceWorkspace;
  }

  // Private: visible ONLY to the specific user who created it
  if (visibility === 'private') {
    if (!resource.userId || !caller.userId) {
      return false;
    }
    return caller.userId === resource.userId;
  }

  return false;
}

/**
 * Validates whether a caller can write or modify a resource.
 */
export function canWriteResource(caller: SecurityContext, resource: IsolatedResource): boolean {
  if (caller.role === 'read') return false;

  const resourceTenant = resource.tenantId || 'default';
  if (caller.tenantId !== resourceTenant) return false;

  if (caller.role === 'admin') return true;

  const resourceWorkspace = resource.workspaceId || 'default';
  if (caller.workspaceId !== resourceWorkspace) return false;

  // Private resources can only be modified by their owner
  if (resource.visibility === 'private') {
    return !!caller.userId && caller.userId === resource.userId;
  }

  return true;
}

/**
 * Enforces that caller has read access to resource, throwing RecallError if denied.
 */
export function assertReadAccess(caller: SecurityContext, resource: IsolatedResource, resourceName = 'memory'): void {
  if (!canReadResource(caller, resource)) {
    throw new RecallError(
      `Access denied: Caller context (${caller.tenantId}/${caller.workspaceId}) is not authorized to read ${resourceName} (${resource.tenantId || 'default'}/${resource.workspaceId || 'default'}).`,
      'Verify workspace, project, and tenant isolation configuration.',
    );
  }
}

/**
 * Enforces that caller has write access to resource, throwing RecallError if denied.
 */
export function assertWriteAccess(caller: SecurityContext, resource: IsolatedResource, resourceName = 'memory'): void {
  if (!canWriteResource(caller, resource)) {
    throw new RecallError(
      `Access denied: Caller context is not authorized to modify ${resourceName}.`,
      'Verify write permissions and tenant/workspace credentials.',
    );
  }
}
