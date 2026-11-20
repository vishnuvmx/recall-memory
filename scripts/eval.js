#!/usr/bin/env node
/**
 * Recall Offline Retrieval & Symbol Lookup Evaluation Suite (`npm run eval`)
 *
 * Implements B4 (Retrieval Quality Evaluation):
 * 1. Deterministic 30-memory engineering corpus (+ proposed, archived, and expired distractors)
 *    and 32 labelled ground-truth queries with graded relevance (3 = primary target, 2 = closely
 *    related sibling memory, 1 = partially relevant context).
 * 2. Computes:
 *    - Precision@1, Precision@3, Precision@5
 *    - Recall@1, Recall@3, Recall@5 (for primary target)
 *    - Graded Recall@3, Graded Recall@5 (across all relevant items for the query)
 *    - MRR (Mean Reciprocal Rank)
 *    - nDCG@3, nDCG@5 (Normalized Discounted Cumulative Gain)
 *    - Unnecessary Retrieval Rate (fraction of returned hits with relevance 0)
 *    - Distractor Leak Rate (must be 0.0% — proposed/archived/expired memories must never leak)
 *    - Average Context Tokens Produced
 * 3. Compares 6 retrieval modes (ablation study):
 *    - KEYWORD_ONLY:      Deterministic keyword/stem search (`search()`)
 *    - FTS5_BM25_ONLY:    SQLite FTS5 Porter-stemmed BM25 ranking only
 *    - VECTOR_ONLY:       64-dim MD5 feature-hash cosine similarity only (`getOrGenerateEmbedding`)
 *    - HYBRID_MINMAX:     Production `hybridSearch` default (Identifier + BM25 + Co-occurrence + 64-dim vector)
 *    - HYBRID_RRF:        Reciprocal Rank Fusion (`fusionMode: 'rrf'`)
 *    - HYBRID_RAW:        Unnormalized raw linear sum (`fusionMode: 'raw'`)
 * 4. Evaluates Code Symbol & File Lookup (`whereIs`) against 14 ground-truth symbol/file targets,
 *    reporting exact coverage gaps (e.g., unmodified TypeScript class methods, exported constants,
 *    and multi-word queries) separately from false positives.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  initProject,
  agentRemember,
  archive,
  search,
  hybridSearch,
  contextHybrid,
  formatHybridHitsCompact,
  getOrGenerateEmbedding,
  cosineSimilarity,
  getSharedSqliteStore,
  closeSharedSqliteStore,
  loadSearchableMemories,
  whereIs,
} from '../dist/index.js';

export const EVAL_DATASET_VERSION = 'recall-eval-ds-v1';

export const CORPUS = [
  {
    key: 'auth_jwt_401',
    title: 'JWT 401 bug on container clock skew',
    type: 'bugfix',
    tags: ['auth', 'jwt', 'token', 'clock'],
    text: 'Bearer tokens rejected with HTTP 401 when container NTP drifted by >30s. Added 60s clockTolerance to jwt.verify during token validation.',
  },
  {
    key: 'auth_cookie_samesite',
    title: 'Session cookie SameSite=Lax requirement for OAuth callback',
    type: 'decision',
    tags: ['auth', 'oauth', 'cookie', 'login', 'signin', 'session', 'jwt'],
    text: 'Use SameSite=Lax instead of Strict on the session cookie so external OAuth login and signin redirects preserve session state before issuing JWT.',
  },
  {
    key: 'db_sqlite_wal',
    title: 'SQLite WAL pragma and busy_timeout for concurrent writers',
    type: 'decision',
    tags: ['database', 'sqlite', 'storage', 'concurrency', 'locking'],
    text: 'Enable PRAGMA journal_mode=WAL and busy_timeout=5000 on SQLite connections to prevent SQLITE_BUSY errors under parallel writes.',
  },
  {
    key: 'db_migration_lock',
    title: 'Advisory lock required before running schema migration',
    type: 'convention',
    tags: ['database', 'migration', 'schema', 'postgres', 'ddl'],
    text: 'Always acquire pg_advisory_lock in runner before altering tables so multi-replica deployments do not race on DDL.',
  },
  {
    key: 'db_n_plus_one',
    title: 'Batch dataloader for user permission lookup',
    type: 'bugfix',
    tags: ['database', 'postgres', 'latency', 'permissions', 'sql'],
    text: 'Fixed N+1 SQL spike on dashboard load by batching permission checks into a single WHERE user_id = ANY($1) query.',
  },
  {
    key: 'cache_prompt_invalidation',
    title: 'Keep AGENTS.md static to preserve LLM prompt cache',
    type: 'convention',
    tags: ['cache', 'tokens', 'cost', 'billing', 'agents', 'prompt'],
    text: 'Never embed timestamps or dynamic session state inside AGENTS.md because changing system prefix invalidates provider prompt caching and multiplies token cost.',
  },
  {
    key: 'sec_secret_entropy',
    title: 'Secret scanner Shannon entropy allowlist for file paths',
    type: 'bugfix',
    tags: ['security', 'secrets', 'entropy', 'scanner', 'validation'],
    text: 'High-entropy secret detection false-positived on long TypeScript paths like src/security/isolation.ts. Added path/extension allowlist before entropy calculation.',
  },
  {
    key: 'sec_prompt_poisoning',
    title: 'Quarantine untrusted memories failing prompt injection checks',
    type: 'decision',
    tags: ['security', 'poisoning', 'injection', 'sanitization', 'prompt'],
    text: 'Strip zero-width characters and block instruction override payloads or synthetic system role tags before storing or injecting memory.',
  },
  {
    key: 'sec_path_traversal',
    title: 'Enforce resolveInside check on all .recall file writes',
    type: 'convention',
    tags: ['security', 'filesystem', 'path', 'sandbox', 'symlink'],
    text: 'Every path inside .recall must pass resolveInside(recallDir, rel) to block symlink escapes and directory traversal attacks.',
  },
  {
    key: 'api_rate_limit',
    title: 'Token bucket rate limiter uses Redis sliding window',
    type: 'decision',
    tags: ['api', 'ratelimit', 'throttle', 'redis', '429'],
    text: 'Public REST endpoints enforce 120 req/min per API key using a Redis Lua script returning HTTP 429 Too Many Requests with Retry-After header.',
  },
  {
    key: 'api_idempotency',
    title: 'Idempotency-Key header required on payment charge POST',
    type: 'convention',
    tags: ['api', 'payments', 'billing', 'stripe', 'idempotency', 'retry'],
    text: 'All POST /v1/charges requests must supply an Idempotency-Key UUID cached for 24h to prevent duplicate credit card charges when a client retry occurs.',
  },
  {
    key: 'api_cors_credentials',
    title: 'CORS Access-Control-Allow-Origin cannot be wildcard with credentials',
    type: 'bugfix',
    tags: ['api', 'cors', 'browser', 'headers', 'fetch', 'preflight'],
    text: 'Browser fetch with credentials: include failed preflight OPTIONS when Access-Control-Allow-Origin was *. Echo explicit origin from allowlist.',
  },
  {
    key: 'build_esm_extensions',
    title: 'TypeScript NodeNext imports require explicit .js extension',
    type: 'convention',
    tags: ['build', 'typescript', 'esm', 'imports', 'compiler'],
    text: 'With moduleResolution NodeNext, all relative TypeScript imports in src/ must end with .js so compiled dist/ files resolve under Node ESM.',
  },
  {
    key: 'build_circular_dep',
    title: 'Avoid circular import between service.ts and chat-sync.ts',
    type: 'lesson',
    tags: ['build', 'architecture', 'imports', 'circular'],
    text: 'Keep low-level helpers in memory.ts or passport.ts so chat-sync.ts can call agentRemember in service.ts without circular initialization errors.',
  },
  {
    key: 'test_temp_cleanup',
    title: 'Isolate test fixtures in os.tmpdir and remove in finally block',
    type: 'convention',
    tags: ['testing', 'ci', 'filesystem', 'cleanup'],
    text: 'Unit tests in tests/recall.test.mjs must create temporary workspaces via fs.mkdtempSync(os.tmpdir()) and clean up after execution.',
  },
  {
    key: 'win_atomic_rename',
    title: 'Windows EPERM retry on atomicWrite rename over existing file',
    type: 'bugfix',
    tags: ['windows', 'filesystem', 'atomic', 'eperm', 'locking'],
    text: 'fs.renameSync intermittently throws EPERM on Windows when antivirus or indexers hold a brief handle. Write to .tmp and retry rename with fallback.',
  },
  {
    key: 'win_posix_paths',
    title: 'Normalize Windows backslashes with toPosix before storing paths',
    type: 'convention',
    tags: ['windows', 'paths', 'cross-platform', 'git'],
    text: 'Convert all relative paths using toPosix(p) so INDEX.md links, landmarks cache keys, and git paths match across Windows, macOS, and Linux.',
  },
  {
    key: 'cli_stdin_tty',
    title: 'Non-blocking stdin reader timeout for lifecycle hooks',
    type: 'bugfix',
    tags: ['cli', 'hooks', 'stdin', 'hang', 'timeout'],
    text: 'recall checkpoint --hook hung when invoked without piped input on some shells. Added 150ms readStdinNonBlocking timeout and TTY check.',
  },
  {
    key: 'hook_claude_settings',
    title: 'Register Claude Code hooks in .claude/settings.local.json',
    type: 'decision',
    tags: ['hooks', 'claude', 'agent', 'configuration', 'automation'],
    text: 'Install Stop and SessionStart lifecycle hooks into .claude/settings.local.json (or existing settings.json) without clobbering user keys.',
  },
  {
    key: 'passport_fingerprint',
    title: 'SHA-256 fingerprint skips cold-run PASSPORT.md regeneration',
    type: 'decision',
    tags: ['passport', 'cache', 'fingerprint', 'performance', 'cold-start'],
    text: 'syncPassport hashes package manifests, lockfiles, and active memories into .recall/.cache/fingerprint.json so unchanged repos do zero re-analysis.',
  },
  {
    key: 'landmarks_mtime_cache',
    title: 'Cache regex code landmarks by file mtimeMs and size',
    type: 'decision',
    tags: ['where', 'landmarks', 'symbols', 'cache', 'performance'],
    text: 'scanLandmarks stores extracted functions and classes in .recall/.cache/landmarks.json keyed by relativePath, mtimeMs, and byte size.',
  },
  {
    key: 'failed_ast_wasm',
    title: 'Rejected bundling tree-sitter WASM grammars in core package',
    type: 'failed_approach',
    tags: ['ast', 'wasm', 'bundle', 'size', 'dependencies', 'symbols'],
    text: 'Bundling tree-sitter WASM binaries added 14MB to the npm tarball and slowed CLI cold start by 180ms. Kept zero-dep regex landmarks in core.',
  },
  {
    key: 'failed_git_autocommit',
    title: 'Never run git commit automatically inside recall commands',
    type: 'failed_approach',
    tags: ['git', 'commits', 'workflow', 'safety'],
    text: 'Auto-committing .recall changes polluted user git history and broke rebase workflows. Recall only writes files; user controls git commits.',
  },
  {
    key: 'queue_exponential_backoff',
    title: 'Write queue uses exponential backoff with jitter on lock contention',
    type: 'decision',
    tags: ['sqlite', 'queue', 'retry', 'concurrency', 'backoff', 'locking'],
    text: 'withRetry retries transient database lock errors up to 5 times with baseDelayMs=25 and random jitter.',
  },
  {
    key: 'ui_design_tokens',
    title: 'Enforce CSS custom property tokens instead of hardcoded hex colors',
    type: 'design_system',
    tags: ['ui', 'css', 'theme', 'colors', 'frontend'],
    text: 'All components must reference --color-surface and --color-accent variables to support dark mode switching.',
  },
  {
    key: 'deploy_zero_downtime',
    title: 'Healthcheck /readyz waits for SQLite warmup before traffic drain',
    type: 'decision',
    tags: ['deploy', 'kubernetes', 'healthcheck', 'readiness', 'containers'],
    text: 'Return HTTP 503 on /readyz until initial store sync finishes so load balancers do not route requests to cold pods.',
  },
  {
    key: 'log_structured_json',
    title: 'Emit structured JSON logs to stderr during MCP and hook execution',
    type: 'convention',
    tags: ['logging', 'mcp', 'stdio', 'stderr', 'json'],
    text: 'Never write diagnostic logs to stdout during hook or MCP execution because stdout is reserved for protocol JSON payloads.',
  },
  {
    key: 'session_retention_prune',
    title: 'Prune session-log.md entries older than 14 days or 50 max',
    type: 'convention',
    tags: ['sessions', 'checkpoint', 'prune', 'retention', 'storage'],
    text: 'pruneSessions bounds .recall/sessions/session-log.md to a 14-day window and at most 50 entries so session logs never bloat the repo.',
  },
  {
    key: 'agy_hook_inject_steps',
    title: 'Antigravity SessionStart hook returns injectSteps systemMessage payload',
    type: 'decision',
    tags: ['hooks', 'antigravity', 'session', 'automation', 'injection'],
    text: 'When hookEventName is SessionStart in Antigravity, output injectSteps containing systemMessage.systemMessage with sanitized project context.',
  },
  {
    key: 'distractor_verbose_notes',
    title: 'General onboarding notes for how the team works with issues',
    type: 'fact',
    tags: ['onboarding', 'general'],
    text: 'When you are working with the project and wondering how or why things are done from day to day, check the issue tracker and talk with the team before making changes.',
  },
];

/**
 * 32 Ground-Truth Queries with Graded Relevance:
 * - expectedKey: primary target (relevance = 3)
 * - graded: map of { [key]: relevance (1..3) }
 */
export const EVAL_QUERIES = [
  // 1. Co-occurrence / tag-bridged queries
  {
    query: 'login failure',
    expectedKey: 'auth_jwt_401',
    graded: { auth_jwt_401: 3, auth_cookie_samesite: 2 },
    category: 'co-occurrence+stem',
  },
  {
    query: 'signin fails when server clock is off',
    expectedKey: 'auth_jwt_401',
    graded: { auth_jwt_401: 3, auth_cookie_samesite: 1 },
    category: 'co-occurrence',
  },
  {
    query: 'oauth login loses state on redirect',
    expectedKey: 'auth_cookie_samesite',
    graded: { auth_cookie_samesite: 3, auth_jwt_401: 1 },
    category: 'co-occurrence',
  },
  {
    query: 'customer billed twice when webhook retried',
    expectedKey: 'api_idempotency',
    graded: { api_idempotency: 3, queue_exponential_backoff: 1 },
    category: 'co-occurrence+stem',
  },
  {
    query: 'throttling incoming client traffic',
    expectedKey: 'api_rate_limit',
    graded: { api_rate_limit: 3, deploy_zero_downtime: 1 },
    category: 'co-occurrence+stem',
  },
  {
    query: 'migrating tables across replicas',
    expectedKey: 'db_migration_lock',
    graded: { db_migration_lock: 3, db_n_plus_one: 1 },
    category: 'co-occurrence+stem',
  },
  {
    query: 'theming variables for dark mode',
    expectedKey: 'ui_design_tokens',
    graded: { ui_design_tokens: 3 },
    category: 'co-occurrence+stem',
  },
  {
    query: 'container traffic routed before warmup completes',
    expectedKey: 'deploy_zero_downtime',
    graded: { deploy_zero_downtime: 3, auth_jwt_401: 1 },
    category: 'co-occurrence',
  },

  // 2. Inflected / morphological variants
  {
    query: 'migrating database columns',
    expectedKey: 'db_migration_lock',
    graded: { db_migration_lock: 3, db_sqlite_wal: 1 },
    category: 'morphology',
  },
  {
    query: 'retried charge requests',
    expectedKey: 'api_idempotency',
    graded: { api_idempotency: 3 },
    category: 'morphology',
  },
  {
    query: 'throttled API clients',
    expectedKey: 'api_rate_limit',
    graded: { api_rate_limit: 3 },
    category: 'morphology',
  },
  {
    query: 'pruning stale history',
    expectedKey: 'session_retention_prune',
    graded: { session_retention_prune: 3 },
    category: 'morphology',
  },
  {
    query: 'customizing component themes',
    expectedKey: 'ui_design_tokens',
    graded: { ui_design_tokens: 3 },
    category: 'morphology',
  },
  {
    query: 'database locked under parallel writes',
    expectedKey: 'db_sqlite_wal',
    graded: { db_sqlite_wal: 3, queue_exponential_backoff: 2, win_atomic_rename: 1 },
    category: 'morphology',
  },

  // 3. Conversational stopword-heavy queries
  {
    query: 'why is token billing so expensive when system prompt changes',
    expectedKey: 'cache_prompt_invalidation',
    graded: { cache_prompt_invalidation: 3 },
    category: 'stopwords',
  },
  {
    query: 'how do we fix slow permission lookups on dashboard',
    expectedKey: 'db_n_plus_one',
    graded: { db_n_plus_one: 3 },
    category: 'stopwords',
  },
  {
    query: 'how to stop untrusted input from hijacking agent instructions',
    expectedKey: 'sec_prompt_poisoning',
    graded: { sec_prompt_poisoning: 3, cache_prompt_invalidation: 1 },
    category: 'stopwords',
  },
  {
    query: 'false positive entropy alert on TypeScript file path',
    expectedKey: 'sec_secret_entropy',
    graded: { sec_secret_entropy: 3, build_esm_extensions: 1 },
    category: 'stopwords',
  },

  // 4. Technical identifiers & error codes
  {
    query: 'SQLITE_BUSY error under load',
    expectedKey: 'db_sqlite_wal',
    graded: { db_sqlite_wal: 3, queue_exponential_backoff: 2 },
    category: 'identifier',
  },
  {
    query: 'symlink escape traversal in resolveInside',
    expectedKey: 'sec_path_traversal',
    graded: { sec_path_traversal: 3 },
    category: 'identifier',
  },
  {
    query: 'CORS preflight fails when credentials include is set',
    expectedKey: 'api_cors_credentials',
    graded: { api_cors_credentials: 3 },
    category: 'identifier',
  },
  {
    query: 'NodeNext relative imports failing in ESM build',
    expectedKey: 'build_esm_extensions',
    graded: { build_esm_extensions: 3, build_circular_dep: 1 },
    category: 'identifier',
  },
  {
    query: 'circular dependency between service.ts and chat-sync.ts',
    expectedKey: 'build_circular_dep',
    graded: { build_circular_dep: 3 },
    category: 'identifier',
  },
  {
    query: 'EPERM error renaming files on Windows',
    expectedKey: 'win_atomic_rename',
    graded: { win_atomic_rename: 3, win_posix_paths: 1 },
    category: 'identifier',
  },

  // 5. Natural engineering queries & architecture decisions
  {
    query: 'normalize Windows backslashes for git and index links',
    expectedKey: 'win_posix_paths',
    graded: { win_posix_paths: 3, win_atomic_rename: 1 },
    category: 'natural',
  },
  {
    query: 'hook process hangs waiting on stdin when no pipe',
    expectedKey: 'cli_stdin_tty',
    graded: { cli_stdin_tty: 3, hook_claude_settings: 1 },
    category: 'natural',
  },
  {
    query: 'why we do not bundle tree-sitter WASM for symbols',
    expectedKey: 'failed_ast_wasm',
    graded: { failed_ast_wasm: 3, landmarks_mtime_cache: 2 },
    category: 'decision',
  },
  {
    query: 'exponential backoff jitter when database is locked',
    expectedKey: 'queue_exponential_backoff',
    graded: { queue_exponential_backoff: 3, db_sqlite_wal: 2 },
    category: 'natural',
  },
  {
    query: 'skip regenerating PASSPORT.md when fingerprint matches',
    expectedKey: 'passport_fingerprint',
    graded: { passport_fingerprint: 3, landmarks_mtime_cache: 1 },
    category: 'decision',
  },
  {
    query: 'cache extracted symbols by file mtimeMs and size',
    expectedKey: 'landmarks_mtime_cache',
    graded: { landmarks_mtime_cache: 3, passport_fingerprint: 1 },
    category: 'decision',
  },
  {
    query: 'never auto-commit .recall files in git',
    expectedKey: 'failed_git_autocommit',
    graded: { failed_git_autocommit: 3 },
    category: 'decision',
  },
  {
    query: 'Antigravity SessionStart injectSteps systemMessage format',
    expectedKey: 'agy_hook_inject_steps',
    graded: { agy_hook_inject_steps: 3, hook_claude_settings: 2 },
    category: 'natural',
  },
];

/**
 * Ground-Truth Symbol & File Lookup Queries (`whereIs`) against a deterministic fixture
 * to measure symbol indexing coverage (functions, classes, methods, constants, multi-word queries).
 */
export const SYMBOL_EVAL_TARGETS = [
  { query: 'AuthTokenService', expectedFile: 'src/auth/token-service.ts', expectedName: 'AuthTokenService', category: 'exported-class' },
  { query: 'verifyBearerToken', expectedFile: 'src/auth/token-service.ts', expectedName: 'verifyBearerToken', category: 'exported-function' },
  { query: 'issueRefreshToken', expectedFile: 'src/auth/token-service.ts', expectedName: 'issueRefreshToken', category: 'async-class-method' },
  { query: 'revokeSessionSync', expectedFile: 'src/auth/token-service.ts', expectedName: 'revokeSessionSync', category: 'unmodified-class-method' },
  { query: 'validateClaimsInternal', expectedFile: 'src/auth/token-service.ts', expectedName: 'validateClaimsInternal', category: 'private-class-method' },
  { query: 'TokenValidationOptions', expectedFile: 'src/auth/token-service.ts', expectedName: 'TokenValidationOptions', category: 'exported-interface' },
  { query: 'TokenGrantKind', expectedFile: 'src/auth/token-service.ts', expectedName: 'TokenGrantKind', category: 'exported-type' },
  { query: 'DEFAULT_CLOCK_TOLERANCE_SEC', expectedFile: 'src/auth/token-service.ts', expectedName: 'DEFAULT_CLOCK_TOLERANCE_SEC', category: 'exported-const' },
  { query: 'LedgerRepository', expectedFile: 'src/db/ledger-repo.ts', expectedName: 'LedgerRepository', category: 'exported-class' },
  { query: 'commitTransactionSync', expectedFile: 'src/db/ledger-repo.ts', expectedName: 'commitTransactionSync', category: 'unmodified-class-method' },
  { query: 'appendImmutableEntry', expectedFile: 'src/db/ledger-repo.ts', expectedName: 'appendImmutableEntry', category: 'exported-arrow-fn' },
  { query: 'ledger-repo.ts', expectedFile: 'src/db/ledger-repo.ts', expectedName: 'src/db/ledger-repo.ts', category: 'file-path' },
  { query: 'token service', expectedFile: 'src/auth/token-service.ts', expectedName: 'AuthTokenService', category: 'multi-word-query' },
  { query: 'verify bearer', expectedFile: 'src/auth/token-service.ts', expectedName: 'verifyBearerToken', category: 'multi-word-query' },
];

function computeDcg(relevances, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    const rel = relevances[i] ?? 0;
    if (rel > 0) {
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }
  }
  return dcg;
}

function computeNdcg(retrievedKeys, gradedMap, k) {
  const actualRels = retrievedKeys.slice(0, k).map((key) => gradedMap[key] ?? 0);
  const idealRels = Object.values(gradedMap).sort((a, b) => b - a);
  const idcg = computeDcg(idealRels, k);
  if (idcg === 0) return 0;
  return computeDcg(actualRels, k) / idcg;
}

function runModeRetrieval(mode, memories, store, query, limit = 5) {
  const activeOnly = memories.filter(
    (m) => m.status === 'active' && !m.deprecated && (!m.expiresAt || m.expiresAt >= new Date().toISOString().slice(0, 10)),
  );

  if (mode === 'KEYWORD_ONLY') {
    const hits = search(memories, query, { limit });
    const text = hits.map((h) => `- ${h.memory.title}: ${h.excerpt}`).join('\n');
    return {
      hits: hits.map((h) => ({ memory: h.memory, score: h.score, excerpt: h.excerpt })),
      tokens: Math.ceil(text.length / 4),
    };
  }

  if (mode === 'FTS5_BM25_ONLY') {
    const ftsHits = store.ftsBm25Search(query, limit * 2);
    const byId = new Map(activeOnly.map((m) => [m.id, m]));
    const hits = [];
    for (const fh of ftsHits) {
      const m = byId.get(fh.id);
      if (m) {
        hits.push({ memory: m, score: fh.bm25Score, excerpt: m.body.slice(0, 160) });
        if (hits.length >= limit) break;
      }
    }
    const text = hits.map((h) => `- ${h.memory.title}: ${h.excerpt}`).join('\n');
    return { hits, tokens: Math.ceil(text.length / 4) };
  }

  if (mode === 'VECTOR_ONLY') {
    const qVec = getOrGenerateEmbedding(query).vector;
    const scored = activeOnly
      .map((m) => {
        const mVec = store.getEmbedding(m.id) ?? getOrGenerateEmbedding(`${m.title}\n${m.body}`).vector;
        const sim = cosineSimilarity(qVec, mVec);
        return { memory: m, score: sim, excerpt: m.body.slice(0, 160) };
      })
      .filter((x) => x.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const text = scored.map((h) => `- ${h.memory.title}: ${h.excerpt}`).join('\n');
    return { hits: scored, tokens: Math.ceil(text.length / 4) };
  }

  if (mode === 'HYBRID_WITH_MD5_VECTOR') {
    const hits = hybridSearch(memories, query, { limit, sqliteStore: store, fusionMode: 'minmax', disableVector: false });
    const formatted = formatHybridHitsCompact(hits);
    return { hits, tokens: Math.ceil(formatted.length / 4) };
  }

  const fusionMap = {
    HYBRID_MINMAX: 'minmax',
    HYBRID_RRF: 'rrf',
    HYBRID_RAW: 'raw',
  };
  const fusionMode = fusionMap[mode] ?? 'minmax';
  const hits = hybridSearch(memories, query, { limit, sqliteStore: store, fusionMode });
  const formatted = formatHybridHitsCompact(hits);
  return { hits, tokens: Math.ceil(formatted.length / 4) };
}

/**
 * Second Independent Representative Corpus (Dataset B: Frontend, Mobile, UI, Data Pipeline, Typos & Synonyms)
 * Validates whether 64-dim MD5 vectors help or hurt across a completely different engineering domain.
 */
const DATASET_B_CORPUS = [
  {
    key: 'ui_modal_focus',
    title: 'Trap keyboard focus inside accessible dialog modal',
    type: 'convention',
    tags: ['ui', 'accessibility', 'a11y', 'modal', 'dialog', 'keyboard'],
    text: 'Use native HTML <dialog> with showModal() so Escape closes the popup and Tab focus stays trapped inside.',
  },
  {
    key: 'ui_scroll_jank',
    title: 'Virtualize table rows above 200 items to eliminate scroll jank',
    type: 'bugfix',
    tags: ['ui', 'performance', 'table', 'scrolling', 'fps', 'list'],
    text: 'Rendering 1500 DOM rows dropped frame rate below 20fps. Switched DataGrid to windowed row virtualization.',
  },
  {
    key: 'ui_dark_palette',
    title: 'Never use pure black #000000 backgrounds in dark theme surfaces',
    type: 'design_system',
    tags: ['ui', 'theme', 'dark-mode', 'colors', 'design'],
    text: 'Dark mode cards must use --surface-elevated (#121417) instead of #000000 to prevent OLED smearing.',
  },
  {
    key: 'ui_no_material',
    title: 'Do not import Material UI components in custom design system',
    type: 'design_system',
    tags: ['ui', 'design', 'components', 'material', 'styling'],
    text: 'All buttons, inputs, and sheets must use internal Radix primitives styled with project design tokens, never @mui/material.',
  },
  {
    key: 'react_stale_closure',
    title: 'WebSocket message handler stale closure bug in useEffect',
    type: 'bugfix',
    tags: ['react', 'hooks', 'websocket', 'state', 'closure'],
    text: 'Event listener registered once in useEffect captured stale cart state. Use a ref or functional state updater setCart(prev => ...).',
  },
  {
    key: 'react_hydration_tz',
    title: 'SSR hydration mismatch caused by locale date formatting',
    type: 'bugfix',
    tags: ['react', 'ssr', 'nextjs', 'hydration', 'timezone', 'dates'],
    text: 'toLocaleDateString() rendered UTC on server and local timezone on browser. Format timestamps with explicit timeZone: "UTC" or inside client mount.',
  },
  {
    key: 'mobile_ios_keyboard',
    title: 'iOS Safari viewport height jump when virtual keyboard opens',
    type: 'bugfix',
    tags: ['mobile', 'ios', 'safari', 'viewport', 'keyboard', 'css'],
    text: 'Replace 100vh with 100dvh on fixed bottom drawers so the iOS soft keyboard does not push the sticky submit button off-screen.',
  },
  {
    key: 'mobile_flutter_dispose',
    title: 'Dispose TextEditingController and StreamSubscription in widget dispose()',
    type: 'convention',
    tags: ['mobile', 'flutter', 'dart', 'memory-leak', 'lifecycle'],
    text: 'Every StatefulWidget allocating controllers or stream listeners must cancel and dispose them to prevent memory leaks on route pop.',
  },
  {
    key: 'data_parquet_partition',
    title: 'Partition analytics Parquet exports by event_date UTC',
    type: 'decision',
    tags: ['data', 'analytics', 'parquet', 'etl', 'warehouse', 'storage'],
    text: 'Write daily Parquet batches under s3://analytics/dt=YYYY-MM-DD/ so DuckDB and BigQuery prune scans without reading full history.',
  },
  {
    key: 'data_csv_bom',
    title: 'Prefix exported UTF-8 CSV downloads with BOM for Excel compatibility',
    type: 'bugfix',
    tags: ['data', 'csv', 'export', 'excel', 'encoding', 'utf8'],
    text: 'Microsoft Excel garbled accented customer names unless the UTF-8 byte order mark \\uFEFF was prepended to CSV responses.',
  },
  {
    key: 'queue_dlq_replay',
    title: 'Route poison messages to dead-letter queue after 5 consumer failures',
    type: 'decision',
    tags: ['queue', 'messaging', 'dlq', 'retries', 'worker', 'kafka'],
    text: 'Cap consumer retries at 5 attempts with exponential backoff, then move unprocessable payloads to dead-letter topic with stacktrace headers.',
  },
  {
    key: 'search_prefix_trigram',
    title: 'Use pg_trgm GIN index for fuzzy customer name autocomplete',
    type: 'decision',
    tags: ['search', 'postgres', 'autocomplete', 'fuzzy', 'index'],
    text: 'Standard B-tree indexes cannot accelerate leading-wildcard ILIKE queries; created GIN trigram index on customers.full_name.',
  },
  {
    key: 'ci_lockfile_frozen',
    title: 'CI pipelines must run npm ci instead of npm install',
    type: 'convention',
    tags: ['ci', 'github-actions', 'npm', 'lockfile', 'builds'],
    text: 'Always use npm ci in GitHub Actions so package-lock.json drift fails the build deterministically.',
  },
  {
    key: 'auth_pkce_spa',
    title: 'Browser SPAs must use OAuth Authorization Code flow with PKCE',
    type: 'decision',
    tags: ['auth', 'oauth', 'pkce', 'spa', 'security', 'browser'],
    text: 'Implicit grant flow exposes access tokens in URL fragments. Require S256 PKCE code_challenge for all browser clients.',
  },
  {
    key: 'testing_msw_network',
    title: 'Mock external HTTP endpoints with MSW instead of monkey-patching fetch',
    type: 'convention',
    tags: ['testing', 'http', 'mocking', 'msw', 'frontend'],
    text: 'Intercept outbound API calls using Mock Service Worker handlers so tests exercise real serialization and headers.',
  },
  {
    key: 'perf_image_lcp',
    title: 'Preload hero banner image with fetchpriority=high to fix LCP',
    type: 'lesson',
    tags: ['performance', 'cwv', 'lcp', 'images', 'frontend'],
    text: 'Lazy-loading above-the-fold hero images regressed Largest Contentful Paint by 900ms. Mark hero <img> eager with fetchpriority="high".',
  },
];

const DATASET_B_QUERIES = [
  { query: 'popup dialog escape key focus trap', expectedKey: 'ui_modal_focus', graded: { ui_modal_focus: 3 }, category: 'ui' },
  { query: 'slow scrolling lag in large data table', expectedKey: 'ui_scroll_jank', graded: { ui_scroll_jank: 3 }, category: 'perf' },
  { query: 'pure black background dark theme oled', expectedKey: 'ui_dark_palette', graded: { ui_dark_palette: 3 }, category: 'design' },
  { query: 'prohibited material ui library styling', expectedKey: 'ui_no_material', graded: { ui_no_material: 3 }, category: 'design' },
  { query: 'useEffect listener reads outdated react state', expectedKey: 'react_stale_closure', graded: { react_stale_closure: 3 }, category: 'bugfix' },
  { query: 'nextjs hydration error from date timezone', expectedKey: 'react_hydration_tz', graded: { react_hydration_tz: 3 }, category: 'bugfix' },
  { query: 'sticky drawer jumps when iphone keyboard opens', expectedKey: 'mobile_ios_keyboard', graded: { mobile_ios_keyboard: 3 }, category: 'mobile' },
  { query: 'flutter stream controller memory leak on navigation', expectedKey: 'mobile_flutter_dispose', graded: { mobile_flutter_dispose: 3 }, category: 'mobile' },
  { query: 'daily parquet folder partitioning for bigquery', expectedKey: 'data_parquet_partition', graded: { data_parquet_partition: 3 }, category: 'data' },
  { query: 'excel garbled accented characters in csv download', expectedKey: 'data_csv_bom', graded: { data_csv_bom: 3 }, category: 'data' },
  { query: 'worker poison message dead letter topic retries', expectedKey: 'queue_dlq_replay', graded: { queue_dlq_replay: 3 }, category: 'queue' },
  { query: 'postgres fuzzy autocomplete ILIKE index', expectedKey: 'search_prefix_trigram', graded: { search_prefix_trigram: 3 }, category: 'search' },
  { query: 'lockfile drift in github actions build', expectedKey: 'ci_lockfile_frozen', graded: { ci_lockfile_frozen: 3 }, category: 'ci' },
  { query: 'browser spa oauth implicit grant pkce', expectedKey: 'auth_pkce_spa', graded: { auth_pkce_spa: 3 }, category: 'security' },
  { query: 'how to stub api requests in frontend tests', expectedKey: 'testing_msw_network', graded: { testing_msw_network: 3 }, category: 'testing' },
  { query: 'largest contentful paint regressed by lazy hero image', expectedKey: 'perf_image_lcp', graded: { perf_image_lcp: 3 }, category: 'perf' },
  // Near-miss typo queries to specifically test whether 64-dim MD5 character 3-grams actually rescue typos!
  { query: 'virtulize data grid scroling', expectedKey: 'ui_scroll_jank', graded: { ui_scroll_jank: 3 }, category: 'typo' },
  { query: 'hydraton mismatch local datestring', expectedKey: 'react_hydration_tz', graded: { react_hydration_tz: 3 }, category: 'typo' },
];

function evaluateModesOnCorpus(corpus, queries, extraDistractors = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-ds-'));
  try {
    initProject(dir);
    const recallDir = path.join(dir, '.recall');
    const keyToId = new Map();
    const idToKey = new Map();

    for (const item of corpus) {
      const res = agentRemember(dir, {
        title: item.title,
        type: item.type,
        tags: item.tags,
        text: item.text,
      });
      keyToId.set(item.key, res.memory.id);
      idToKey.set(res.memory.id, item.key);
    }

    const distractorIds = new Set();
    if (extraDistractors) {
      const proposedDistractor = agentRemember(dir, {
        title: 'JWT 401 bug on container clock skew UNVERIFIED PROPOSAL',
        type: 'bugfix',
        status: 'proposed',
        tags: ['auth', 'login', 'jwt', 'token'],
        text: 'Proposed unverified login failure 401 auth change that should never be injected or ranked by default.',
      });
      const archivedDistractor = agentRemember(dir, {
        title: 'SQLite WAL pragma and busy_timeout ARCHIVED LEGACY',
        type: 'decision',
        tags: ['database', 'sqlite', 'locking'],
        text: 'Archived SQLITE_BUSY note that was retired.',
      });
      archive(dir, archivedDistractor.memory.id);
      const expiredDistractor = agentRemember(dir, {
        title: 'Temporary rate limit freeze for holiday migration',
        type: 'decision',
        tags: ['api', 'ratelimit', 'throttle', '429'],
        expiresAt: '2020-01-01',
        text: 'Expired rate limiter override that must be filtered out.',
      });
      distractorIds.add(proposedDistractor.memory.id);
      distractorIds.add(archivedDistractor.memory.id);
      distractorIds.add(expiredDistractor.memory.id);
    }

    const allMemories = loadSearchableMemories(recallDir);
    const store = getSharedSqliteStore(recallDir);
    store.ensureSynced(allMemories);

    const modes = [
      'KEYWORD_ONLY',
      'FTS5_BM25_ONLY',
      'VECTOR_ONLY',
      'HYBRID_MINMAX',
      'HYBRID_WITH_MD5_VECTOR',
      'HYBRID_RRF',
      'HYBRID_RAW',
    ];

    const modeReports = {};
    for (const mode of modes) {
      // Warmup 1 query so first-mode JIT compilation doesn't skew ms/Q comparison
      if (queries.length > 0) {
        runModeRetrieval(mode, allMemories, store, queries[0].query, 5);
      }
      let hitsAt1 = 0;
      let hitsAt3 = 0;
      let hitsAt5 = 0;
      let precisionAt1Sum = 0;
      let precisionAt3Sum = 0;
      let precisionAt5Sum = 0;
      let gradedRecallAt3Sum = 0;
      let gradedRecallAt5Sum = 0;
      let mrrSum = 0;
      let ndcgAt3Sum = 0;
      let ndcgAt5Sum = 0;
      let unnecessaryAt3Sum = 0;
      let distractorLeaks = 0;
      let totalTokens = 0;
      const nonTop1 = [];
      const missesAt3 = [];

      const t0 = performance.now();
      for (const q of queries) {
        const expectedId = keyToId.get(q.expectedKey);
        const { hits, tokens } = runModeRetrieval(mode, allMemories, store, q.query, 5);
        totalTokens += tokens;

        if (hits.some((h) => distractorIds.has(h.memory.id))) distractorLeaks++;

        const retrievedKeys = hits.map((h) => idToKey.get(h.memory.id) ?? h.memory.id);
        const primaryRankIdx = hits.findIndex((h) => h.memory.id === expectedId);

        if (primaryRankIdx === 0) hitsAt1++;
        if (primaryRankIdx >= 0 && primaryRankIdx < 3) hitsAt3++;
        if (primaryRankIdx >= 0 && primaryRankIdx < 5) hitsAt5++;
        if (primaryRankIdx >= 0) mrrSum += 1 / (primaryRankIdx + 1);

        const relCount = (k) => retrievedKeys.slice(0, k).filter((key) => (q.graded[key] ?? 0) > 0).length;
        const totalRelevantForQuery = Object.keys(q.graded).length;

        const k1Denom = Math.min(1, Math.max(1, hits.length));
        const k3Denom = Math.min(3, Math.max(1, hits.length));
        const k5Denom = Math.min(5, Math.max(1, hits.length));

        precisionAt1Sum += hits.length > 0 ? relCount(1) / k1Denom : 0;
        precisionAt3Sum += hits.length > 0 ? relCount(3) / k3Denom : 0;
        precisionAt5Sum += hits.length > 0 ? relCount(5) / k5Denom : 0;

        gradedRecallAt3Sum += relCount(3) / totalRelevantForQuery;
        gradedRecallAt5Sum += relCount(5) / totalRelevantForQuery;

        ndcgAt3Sum += computeNdcg(retrievedKeys, q.graded, 3);
        ndcgAt5Sum += computeNdcg(retrievedKeys, q.graded, 5);

        const top3Hits = retrievedKeys.slice(0, 3);
        const irrelevantInTop3 = top3Hits.filter((key) => (q.graded[key] ?? 0) === 0).length;
        unnecessaryAt3Sum += top3Hits.length > 0 ? irrelevantInTop3 / top3Hits.length : 0;

        if (primaryRankIdx > 0) {
          nonTop1.push({ query: q.query, category: q.category, rank: primaryRankIdx + 1, top1Title: hits[0]?.memory.title ?? 'none' });
        }
        if (primaryRankIdx === -1 || primaryRankIdx >= 3) {
          missesAt3.push({ query: q.query, category: q.category, expectedKey: q.expectedKey, rank: primaryRankIdx === -1 ? 'MISS' : primaryRankIdx + 1, got: hits.slice(0, 3).map((r) => r.memory.title) });
        }
      }
      const elapsedMs = performance.now() - t0;
      const Q = queries.length;

      modeReports[mode] = {
        queries: Q,
        recallAt1Pct: Number(((hitsAt1 / Q) * 100).toFixed(1)),
        recallAt3Pct: Number(((hitsAt3 / Q) * 100).toFixed(1)),
        recallAt5Pct: Number(((hitsAt5 / Q) * 100).toFixed(1)),
        gradedRecallAt3Pct: Number(((gradedRecallAt3Sum / Q) * 100).toFixed(1)),
        gradedRecallAt5Pct: Number(((gradedRecallAt5Sum / Q) * 100).toFixed(1)),
        precisionAt1Pct: Number(((precisionAt1Sum / Q) * 100).toFixed(1)),
        precisionAt3Pct: Number(((precisionAt3Sum / Q) * 100).toFixed(1)),
        precisionAt5Pct: Number(((precisionAt5Sum / Q) * 100).toFixed(1)),
        mrr: Number((mrrSum / Q).toFixed(3)),
        ndcgAt3: Number((ndcgAt3Sum / Q).toFixed(3)),
        ndcgAt5: Number((ndcgAt5Sum / Q).toFixed(3)),
        unnecessaryRateAt3Pct: Number(((unnecessaryAt3Sum / Q) * 100).toFixed(1)),
        distractorLeakRatePct: Number(((distractorLeaks / Q) * 100).toFixed(1)),
        avgContextTokens: Math.round(totalTokens / Q),
        totalMs: Number(elapsedMs.toFixed(2)),
        msPerQuery: Number((elapsedMs / Q).toFixed(3)),
        hitsAt1,
        hitsAt3,
        hitsAt5,
        nonTop1,
        missesAt3,
      };
    }

    const e2eT0 = performance.now();
    for (const q of queries) {
      contextHybrid(dir, q.query, { limit: 5, fusionMode: 'minmax' });
    }
    const e2eTotalMs = performance.now() - e2eT0;

    return {
      modeReports,
      distractorCount: distractorIds.size,
      endToEndContextHybridMsPerQuery: Number((e2eTotalMs / queries.length).toFixed(2)),
    };
  } finally {
    closeSharedSqliteStore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function runEvaluationSuite(opts = { silent: false }) {
  const datasetA = evaluateModesOnCorpus(CORPUS, EVAL_QUERIES, true);
  const datasetB = evaluateModesOnCorpus(DATASET_B_CORPUS, DATASET_B_QUERIES, false);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-sym-'));
  try {
    // Seed symbol fixture files for symbol lookup evaluation
    fs.mkdirSync(path.join(tmpRoot, 'src', 'auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'src', 'db'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'auth', 'token-service.ts'),
      [
        'export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;',
        '',
        'export type TokenGrantKind = "access" | "refresh";',
        '',
        'export interface TokenValidationOptions {',
        '  clockToleranceSec: number;',
        '  audience?: string;',
        '}',
        '',
        'export function verifyBearerToken(rawHeader: string, opts?: TokenValidationOptions): boolean {',
        '  return rawHeader.startsWith("Bearer ") && (opts?.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC) >= 0;',
        '}',
        '',
        'export class AuthTokenService {',
        '  async issueRefreshToken(userId: string): Promise<string> {',
        '    return `refresh_${userId}`;',
        '  }',
        '',
        '  revokeSessionSync(sessionId: string): boolean {',
        '    return sessionId.length > 0;',
        '  }',
        '',
        '  private validateClaimsInternal(claims: Record<string, unknown>): boolean {',
        '    return Boolean(claims.sub);',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'db', 'ledger-repo.ts'),
      [
        'export const appendImmutableEntry = async (accountId: string, deltaCents: number): Promise<boolean> => {',
        '  return accountId.length > 0 && Number.isInteger(deltaCents);',
        '};',
        '',
        'export class LedgerRepository {',
        '  commitTransactionSync(txId: string): void {',
        '    void txId;',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    initProject(tmpRoot);

    // Evaluate Symbol & File Lookup (`whereIs`) against SYMBOL_EVAL_TARGETS
    let symHitsAt1 = 0;
    let symHitsAt5 = 0;
    let symMrrSum = 0;
    const symbolGaps = [];

    for (const target of SYMBOL_EVAL_TARGETS) {
      const results = whereIs(tmpRoot, target.query, 10);
      const rankIdx = results.findIndex(
        (r) => r.file === target.expectedFile && r.name === target.expectedName,
      );
      if (rankIdx === 0) symHitsAt1++;
      if (rankIdx >= 0 && rankIdx < 5) symHitsAt5++;
      if (rankIdx >= 0) {
        symMrrSum += 1 / (rankIdx + 1);
      } else {
        symbolGaps.push({
          query: target.query,
          category: target.category,
          expected: `${target.expectedFile} -> ${target.expectedName}`,
          got: results.slice(0, 3).map((r) => `${r.file}:${r.line} ${r.name} (${r.kind})`),
        });
      }
    }

    const S = SYMBOL_EVAL_TARGETS.length;
    const symbolReport = {
      totalTargets: S,
      hitsAt1: symHitsAt1,
      hitsAt5: symHitsAt5,
      recallAt1Pct: Number(((symHitsAt1 / S) * 100).toFixed(1)),
      recallAt5Pct: Number(((symHitsAt5 / S) * 100).toFixed(1)),
      mrr: Number((symMrrSum / S).toFixed(3)),
      missingTargets: symbolGaps,
    };

    const report = {
      datasetVersion: EVAL_DATASET_VERSION,
      corpusSize: CORPUS.length,
      distractorCount: datasetA.distractorCount,
      queryCount: EVAL_QUERIES.length,
      modes: datasetA.modeReports,
      endToEndContextHybridMsPerQuery: datasetA.endToEndContextHybridMsPerQuery,
      datasetB: {
        corpusSize: DATASET_B_CORPUS.length,
        queryCount: DATASET_B_QUERIES.length,
        modes: datasetB.modeReports,
      },
      symbolLookup: symbolReport,
    };

    if (!opts.silent) {
      const printTable = (title, corpusLen, qLen, distractorLen, modeReports) => {
        console.log('============================================================================');
        console.log(`  ${title}`);
        console.log('============================================================================');
        console.log(`Corpus: ${corpusLen} active memories${distractorLen ? ` + ${distractorLen} lifecycle distractors` : ''} | Queries: ${qLen}\n`);
        console.log(
          'Mode             | Rec@1  | Rec@3  | Prec@1 | Prec@3 | MRR   | nDCG@3 | nDCG@5 | Unnec@3 | Leaks | Tok/Q | ms/Q',
        );
        console.log(
          '-----------------|--------|--------|--------|--------|-------|--------|--------|---------|-------|-------|-------',
        );
        for (const [mode, r] of Object.entries(modeReports)) {
          console.log(
            `${mode.padEnd(16)} | ${String(r.recallAt1Pct + '%').padStart(6)} | ${String(r.recallAt3Pct + '%').padStart(6)} | ${String(r.precisionAt1Pct + '%').padStart(6)} | ${String(r.precisionAt3Pct + '%').padStart(6)} | ${r.mrr.toFixed(3)} |  ${r.ndcgAt3.toFixed(3)} |  ${r.ndcgAt5.toFixed(3)} |  ${String(r.unnecessaryRateAt3Pct + '%').padStart(6)} | ${String(r.distractorLeakRatePct + '%').padStart(5)} | ${String(r.avgContextTokens).padStart(5)} | ${r.msPerQuery.toFixed(2)}`,
          );
        }
      };

      printTable(`DATASET A — BACKEND / ARCHITECTURE (${EVAL_DATASET_VERSION})`, CORPUS.length, EVAL_QUERIES.length, datasetA.distractorCount, datasetA.modeReports);
      console.log(`\nEnd-to-end contextHybrid (with SQLite stat-key fast-path): ${report.endToEndContextHybridMsPerQuery} ms/query\n`);
      printTable('DATASET B — FRONTEND / MOBILE / DATA / TYPOS (18 Queries)', DATASET_B_CORPUS.length, DATASET_B_QUERIES.length, 0, datasetB.modeReports);

      console.log('\n----------------------------------------------------------------------------');
      console.log('  SYMBOL & FILE LOOKUP COVERAGE EVALUATION (`whereIs`)');
      console.log('----------------------------------------------------------------------------');
      console.log(
        `Targets: ${symbolReport.totalTargets} | Recall@1: ${symbolReport.hitsAt1}/${symbolReport.totalTargets} (${symbolReport.recallAt1Pct}%) | Recall@5: ${symbolReport.hitsAt5}/${symbolReport.totalTargets} (${symbolReport.recallAt5Pct}%) | MRR: ${symbolReport.mrr.toFixed(3)}`,
      );
      if (symbolReport.missingTargets.length > 0) {
        console.log('\nMissing Ground-Truth Symbol / Query Categories:');
        for (const gap of symbolReport.missingTargets) {
          console.log(`  - [${gap.category}] query="${gap.query}" -> expected ${gap.expected} (got: ${gap.got.join(', ') || 'No match'})`);
        }
      }
      console.log('============================================================================\n');
    }

    return report;
  } finally {
    closeSharedSqliteStore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runEvaluationSuite();
}
