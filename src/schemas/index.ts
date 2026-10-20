import { z } from 'zod';

export const MEMORY_TYPES = [
  'fact',
  'decision',
  'convention',
  'lesson',
  'bugfix',
  'failed_approach',
  'task',
  'design_system',
] as const;
export const LIFECYCLE = ['proposed', 'active', 'superseded', 'archived'] as const;
export const VERIFICATION = ['unverified', 'verified', 'needs_review'] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Lifecycle = (typeof LIFECYCLE)[number];
export type Verification = (typeof VERIFICATION)[number];

const dateString = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
);

export const VISIBILITY = ['private', 'workspace', 'public'] as const;
export type Visibility = (typeof VISIBILITY)[number];

export const memoryMetaSchema = z.object({
  id: z.string().regex(/^mem_[a-z0-9_]+$/i, 'expected mem_<id>'),
  title: z.string().trim().min(1),
  type: z.enum(MEMORY_TYPES),
  created: dateString,
  updated: dateString,
  tags: z.array(z.string()).default([]),
  status: z.enum(LIFECYCLE),
  verification: z.enum(VERIFICATION),
  sources: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1.0),
  evidence: z.array(z.string()).default([]),
  validFrom: dateString.optional(),
  expiresAt: dateString.optional(),
  version: z.number().int().positive().default(1),
  supersededBy: z.string().optional(),
  deprecated: z.boolean().default(false),
  deprecatedReason: z.string().optional(),
  tenantId: z.string().default('default'),
  workspaceId: z.string().default('default'),
  projectId: z.string().default('default'),
  userId: z.string().optional(),
  visibility: z.enum(VISIBILITY).default('workspace'),
});
export type MemoryMeta = z.infer<typeof memoryMetaSchema>;

export const PROFILE_TIERS = ['compact', 'standard', 'frontier'] as const;
export type ProfileTier = (typeof PROFILE_TIERS)[number];

export const PROFILE_BUDGETS: Record<ProfileTier, number> = {
  compact: 3000,
  standard: 12000,
  frontier: 45000,
};

export const WRITE_MODES = ['auto', 'review'] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const configSchema = z
  .object({
    version: z.literal(1),
    agentFile: z.string().min(1).default('AGENTS.md'),
    profile: z.enum(PROFILE_TIERS).default('standard'),
    retentionDays: z.number().int().positive().default(14),
    maxLogEntries: z.number().int().positive().default(50),
    /** `auto`: agent memory writes are active immediately. `review`: they land as `proposed` for human approval. */
    writes: z.enum(WRITE_MODES).default('auto'),
    authToken: z.string().optional(),
    authRequired: z.boolean().default(false),
    tenantId: z.string().default('default'),
    workspaceId: z.string().default('default'),
    projectId: z.string().default('default'),
    hybridRetrieval: z.boolean().default(true),
  })
  .strict();
export type RecallConfig = z.infer<typeof configSchema>;

