export { initProject } from './core/init.js';
export { search } from './core/retrieval.js';
export { loadAll, loadSearchableMemories, createMemory, rewriteMemory, updateMemory, findMemory } from './core/memory.js';
export { findProject, requireInitialized } from './core/project.js';
export { rebuildIndex } from './core/index-builder.js';
export { syncAllAgentIntegrations, installAgentBlock } from './core/agent.js';
export {
  remember,
  propose,
  approve,
  approveAll,
  archive,
  archiveAll,
  getProposals,
  context,
  contextHybrid,
  status,
  log,
  map,
  passport,
  checkpoint,
  prune,
  agentRemember,
  findDuplicate,
  findNearDuplicates,
  whereIs,
} from './core/service.js';
export {
  syncPassport,
  buildPassportMarkdown,
  extractProjectIdentity,
  loadFingerprint,
  saveFingerprint,
} from './core/passport.js';
export {
  syncWorkspace,
  parseTranscriptTail,
  extractDurableInsights,
  buildSanitizedInjectionContext,
  processLifecycleHookInput,
  runLifecycleHook,
} from './core/chat-sync.js';
export { seed } from './core/seed.js';
export { generateProjectMap } from './core/mapper.js';
export { recordCheckpoint, buildActiveFileSymbolMap, pruneSessions, pruneSessionLog } from './core/checkpoint.js';
export { runDoctor } from './core/doctor.js';
export { costReport } from './core/cost.js';
export { where, formatWhere } from './core/where.js';
export { detectPromptInjection, assertNotPoisoned, sanitizeUntrustedInput } from './security/poisoning.js';
export { findSecrets, assertNoSecrets, redactSecrets, calculateShannonEntropy } from './security/secrets.js';
export { getSecurityContext, canReadResource, canWriteResource, assertReadAccess, assertWriteAccess } from './security/isolation.js';
export { authenticateRequest, checkAuthorization, getAuthConfig } from './security/auth.js';
export { hybridSearch, formatHybridHitsCompact, extractTechnicalIdentifiers, expandQueryFromCorpus } from './core/hybrid-retrieval.js';
export { getOrGenerateEmbedding, cosineSimilarity, hashContent } from './core/embeddings.js';
export { SqliteMemoryStore, getSharedSqliteStore, closeSharedSqliteStore } from './core/sqlite-store.js';
export { detectConflicts, supersedeMemory, deprecateMemory, isMemoryExpired } from './core/conflict.js';
export { AsyncWriteQueue, globalWriteQueue, withRetry } from './core/write-queue.js';
export { BackgroundQueue, globalBackgroundQueue } from './core/background-queue.js';
export { logger } from './utils/logger.js';

