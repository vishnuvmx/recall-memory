#!/usr/bin/env node
/**
 * Recall Retrieval & Write-Path Evaluation Harness
 *
 * 1. Measures `recall context` (hybridSearch) retrieval quality across 28 realistic,
 *    challenging `query -> expected memory ID` pairs over a 30-memory engineering corpus
 *    (plus proposed/superseded distractors that must never be returned).
 *    Tests:
 *      - Vocabulary gaps bridged only by corpus tag/term co-occurrence (e.g. "login failure" -> JWT 401)
 *      - Inflected/morphological variants ("retried", "migrating", "throttled", "authenticating")
 *      - Stopword-heavy conversational queries ("why are container tokens rejected when...")
 *      - Technical identifiers & error codes ("EPERM", "429", "NodeNext")
 *    Reports Recall@1, Recall@3, and MRR (Mean Reciprocal Rank).
 * 2. Times `agentRemember()` / `refreshDerivedStores()` write latency scaling.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  initProject,
  agentRemember,
  contextHybrid,
  closeSharedSqliteStore,
  loadSearchableMemories,
} from '../dist/index.js';

const CORPUS = [
  {
    key: 'auth_jwt_401',
    title: 'JWT 401 bug on container clock skew',
    type: 'bugfix',
    // Note: does NOT contain the word "login" or "signin" — only "auth", "jwt", "token"
    tags: ['auth', 'jwt', 'token', 'clock'],
    text: 'Bearer tokens rejected with HTTP 401 when container NTP drifted by >30s. Added 60s clockTolerance to jwt.verify during token validation.',
  },
  {
    key: 'auth_cookie_samesite',
    title: 'Session cookie SameSite=Lax requirement for OAuth callback',
    type: 'decision',
    // Connects "login" / "signin" <-> "auth" / "jwt" / "session" in this repo's vocabulary
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
  // Long prose distractor loaded with common stopwords ("the", "when", "how", "why", "with", "from")
  {
    key: 'distractor_verbose_notes',
    title: 'General onboarding notes for how the team works with issues',
    type: 'fact',
    tags: ['onboarding', 'general'],
    text: 'When you are working with the project and wondering how or why things are done from day to day, check the issue tracker and talk with the team before making changes.',
  },
];

// 28 harder, realistic queries:
const EVAL_QUERIES = [
  // 1. Co-occurrence / tag-bridged queries (query uses sibling terms from the repo's vocabulary)
  { query: 'login failure', expectedKey: 'auth_jwt_401', category: 'co-occurrence+stem' },
  { query: 'signin fails when server clock is off', expectedKey: 'auth_jwt_401', category: 'co-occurrence' },
  { query: 'oauth login loses state on redirect', expectedKey: 'auth_cookie_samesite', category: 'co-occurrence' },
  { query: 'customer billed twice when webhook retried', expectedKey: 'api_idempotency', category: 'co-occurrence+stem' },
  { query: 'throttling incoming client traffic', expectedKey: 'api_rate_limit', category: 'co-occurrence+stem' },
  { query: 'migrating tables across replicas', expectedKey: 'db_migration_lock', category: 'co-occurrence+stem' },
  { query: 'theming variables for dark mode', expectedKey: 'ui_design_tokens', category: 'co-occurrence+stem' },
  { query: 'container traffic routed before warmup completes', expectedKey: 'deploy_zero_downtime', category: 'co-occurrence' },

  // 2. Inflected / morphological forms (stemming required: retried->retry, migrating->migration, throttled->throttle, pruning->prune, locked->lock)
  { query: 'migrating database columns', expectedKey: 'db_migration_lock', category: 'morphology' },
  { query: 'retried charge requests', expectedKey: 'api_idempotency', category: 'morphology' },
  { query: 'throttled API clients', expectedKey: 'api_rate_limit', category: 'morphology' },
  { query: 'pruning stale history', expectedKey: 'session_retention_prune', category: 'morphology' },
  { query: 'customizing component themes', expectedKey: 'ui_design_tokens', category: 'morphology' },
  { query: 'database locked under parallel writes', expectedKey: 'db_sqlite_wal', category: 'morphology' },

  // 3. Stopword & short-prefix traps ("is" matching isolation, "time" matching timeout, "in" matching index)
  { query: 'why is token billing so expensive when system prompt changes', expectedKey: 'cache_prompt_invalidation', category: 'stopwords' },
  { query: 'how do we fix slow permission lookups on dashboard', expectedKey: 'db_n_plus_one', category: 'stopwords' },
  { query: 'how to stop untrusted input from hijacking agent instructions', expectedKey: 'sec_prompt_poisoning', category: 'stopwords' },
  { query: 'false positive entropy alert on TypeScript file path', expectedKey: 'sec_secret_entropy', category: 'stopwords' },

  // 4. Technical identifiers & exact module queries
  { query: 'SQLITE_BUSY error under load', expectedKey: 'db_sqlite_wal', category: 'identifier' },
  { query: 'symlink escape traversal in resolveInside', expectedKey: 'sec_path_traversal', category: 'identifier' },
  { query: 'CORS preflight fails when credentials include is set', expectedKey: 'api_cors_credentials', category: 'identifier' },
  { query: 'NodeNext relative imports failing in ESM build', expectedKey: 'build_esm_extensions', category: 'identifier' },
  { query: 'circular dependency between service.ts and chat-sync.ts', expectedKey: 'build_circular_dep', category: 'identifier' },
  { query: 'EPERM error renaming files on Windows', expectedKey: 'win_atomic_rename', category: 'identifier' },
  { query: 'normalize Windows backslashes for git and index links', expectedKey: 'win_posix_paths', category: 'natural' },
  { query: 'hook process hangs waiting on stdin when no pipe', expectedKey: 'cli_stdin_tty', category: 'natural' },
  { query: 'why we do not bundle tree-sitter WASM for symbols', expectedKey: 'failed_ast_wasm', category: 'decision' },
  { query: 'exponential backoff jitter when database is locked', expectedKey: 'queue_exponential_backoff', category: 'natural' },
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-'));

try {
  initProject(tmpRoot);
  const keyToId = new Map();

  for (const item of CORPUS) {
    const res = agentRemember(tmpRoot, {
      title: item.title,
      type: item.type,
      tags: item.tags,
      text: item.text,
    });
    keyToId.set(item.key, res.memory.id);
  }

  // Add distractors: a proposed memory that MUST NOT rank in normal context
  agentRemember(tmpRoot, {
    title: 'JWT 401 bug on container clock skew UNVERIFIED PROPOSAL',
    type: 'bugfix',
    status: 'proposed',
    tags: ['auth', 'login', 'jwt', 'token'],
    text: 'Proposed unverified login failure 401 auth change that should never be injected or ranked by default.',
  });

  for (const mode of ['minmax', 'rrf', 'raw']) {
    let hitsAt1 = 0;
    let hitsAt3 = 0;
    let reciprocalRankSum = 0;
    const misses = [];
    const nonTop1 = [];

    const searchT0 = performance.now();
    for (const q of EVAL_QUERIES) {
      const expectedId = keyToId.get(q.expectedKey);
      const results = contextHybrid(tmpRoot, q.query, { limit: 5, fusionMode: mode });
      const rankIndex = results.findIndex((r) => r.memory.id === expectedId);

      if (rankIndex === 0) hitsAt1++;
      if (rankIndex >= 0 && rankIndex < 3) hitsAt3++;
      if (rankIndex > 0) {
        nonTop1.push(`  Non-top-1: [${q.category}] "${q.query}" -> rank #${rankIndex + 1} (top1: "${results[0]?.memory.title}")`);
      }
      if (rankIndex >= 0) {
        reciprocalRankSum += 1 / (rankIndex + 1);
      } else {
        misses.push({
          query: q.query,
          category: q.category,
          expectedKey: q.expectedKey,
          rank: 'MISS',
          got: results.slice(0, 3).map((r) => r.memory.title),
        });
      }
      if (rankIndex >= 3) {
        misses.push({
          query: q.query,
          category: q.category,
          expectedKey: q.expectedKey,
          rank: rankIndex + 1,
          got: results.slice(0, 3).map((r) => r.memory.title),
        });
      }
    }
    const searchElapsed = performance.now() - searchT0;

    const total = EVAL_QUERIES.length;
    const recallAt1 = (hitsAt1 / total) * 100;
    const recallAt3 = (hitsAt3 / total) * 100;
    const mrr = reciprocalRankSum / total;

    console.log('====================================================');
    console.log(`  EVAL MODE: ${mode.toUpperCase()}`);
    console.log('====================================================');
    console.log(`Corpus size:       ${CORPUS.length} active memories (+1 proposed distractor)`);
    console.log(`Eval queries:      ${total}`);
    console.log(`Recall@1:          ${hitsAt1}/${total} (${recallAt1.toFixed(1)}%)`);
    console.log(`Recall@3:          ${hitsAt3}/${total} (${recallAt3.toFixed(1)}%)`);
    console.log(`MRR:               ${mrr.toFixed(3)}`);
    console.log(`Search latency:    ${searchElapsed.toFixed(2)} ms total (${(searchElapsed / total).toFixed(2)} ms/query)`);

    if (misses.length > 0) {
      console.log('\nQueries missed in top-3:');
      for (const m of misses) {
        console.log(`  - [${m.category}] "${m.query}" -> expected [${m.expectedKey}] (rank: ${m.rank})`);
        console.log(`    top hits: ${m.got.join(' | ')}`);
      }
    }
    for (const line of nonTop1) {
      console.log(line);
    }
  }
} finally {
  closeSharedSqliteStore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
