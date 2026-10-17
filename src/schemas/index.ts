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
});
export type MemoryMeta = z.infer<typeof memoryMetaSchema>;

export const PROFILE_TIERS = ['compact', 'standard', 'frontier'] as const;
export type ProfileTier = (typeof PROFILE_TIERS)[number];

export const PROFILE_BUDGETS: Record<ProfileTier, number> = {
  compact: 3000,
  standard: 12000,
  frontier: 45000,
};

export const configSchema = z
  .object({
    version: z.literal(1),
    agentFile: z.string().min(1).default('AGENTS.md'),
    profile: z.enum(PROFILE_TIERS).default('standard'),
    retentionDays: z.number().int().positive().default(14),
    maxLogEntries: z.number().int().positive().default(50),
  })
  .strict();
export type RecallConfig = z.infer<typeof configSchema>;
