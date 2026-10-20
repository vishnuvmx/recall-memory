export { initProject } from './core/init.js';
export { search } from './core/retrieval.js';
export { loadAll, createMemory, rewriteMemory, updateMemory, findMemory } from './core/memory.js';
export { findProject, requireInitialized } from './core/project.js';
export { rebuildIndex } from './core/index-builder.js';
export {
  remember,
  propose,
  approve,
  approveAll,
  archive,
  archiveAll,
  getProposals,
  context,
  status,
  log,
  map,
  checkpoint,
  prune,
  agentRemember,
  whereIs,
} from './core/service.js';
export { seed } from './core/seed.js';
export { generateProjectMap } from './core/mapper.js';
export { recordCheckpoint, pruneSessions, pruneSessionLog } from './core/checkpoint.js';
export { costReport } from './core/cost.js';
export { where, formatWhere } from './core/where.js';
export { detectPromptInjection, assertNotPoisoned, sanitizeUntrustedInput } from './security/poisoning.js';
export { findSecrets, assertNoSecrets, redactSecrets, calculateShannonEntropy } from './security/secrets.js';
export { getSecurityContext, canReadResource, canWriteResource, assertReadAccess, assertWriteAccess } from './security/isolation.js';
export { authenticateRequest, checkAuthorization, getAuthConfig } from './security/auth.js';
export { hybridSearch, formatHybridHitsCompact, extractTechnicalIdentifiers } from './core/hybrid-retrieval.js';
export { getOrGenerateEmbedding, cosineSimilarity, hashContent } from './core/embeddings.js';
export { SqliteMemoryStore, getSharedSqliteStore, closeSharedSqliteStore } from './core/sqlite-store.js';
export { detectConflicts, supersedeMemory, deprecateMemory, isMemoryExpired } from './core/conflict.js';
export { AsyncWriteQueue, globalWriteQueue, withRetry } from './core/write-queue.js';
export { BackgroundQueue, globalBackgroundQueue } from './core/background-queue.js';
export { logger } from './utils/logger.js';

