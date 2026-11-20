#!/usr/bin/env node
/**
 * Recall Reconstructed Application-Level Benchmark Suite (`npm run bench`)
 *
 * Implements B0–B7 using Node's built-in modules only (zero external dependencies):
 * - B1/B3: Non-intrusive `node:fs` + `syncBuiltinESMExports()` instrumentation counting exact:
 *          `dirsWalked`, `filesStatted`, `filesRead`, `bytesRead`, `filesWritten`, `bytesWritten`,
 *          plus wall-clock latency, CPU time (`process.cpuUsage()`), heap delta, and token count.
 * - B2:    Deterministic, reproducible Small (15 files), Medium (80 files), and Large (240 files)
 *          project fixtures (`recall-bench-ds-v1`) with realistic TypeScript modules, classes,
 *          methods, imports, configs, and memories.
 * - B3:    Application-level workloads against production build (`dist/index.js`):
 *          1. Initial Indexing (`initProject` across Small, Medium, Large fixtures)
 *          2. Fresh-Session Context Preparation (`SessionStart` hook cold vs. warm)
 *          3. Idle Turn Overhead (`Stop` hook when 0 files changed)
 *          4. Incremental Indexing — 1-File Modification (`Stop` hook after 1 file edit)
 *          5. Incremental Indexing — Multi-File Modification (`Stop` hook after 5 file edits)
 *          6. Incremental Indexing — File Rename & File Deletion (`Stop` hook)
 *          7. Dependency Change (`package.json` update -> `syncPassport`)
 *          8. Symbol & File Lookup (`where` cold cache build vs. warm lookup)
 *          9. Memory Persistence Scaling (`agentRemember` N=1..10 vs. N=51..60)
 *          10. Retrieval Latency & I/O (`search` vs. `hybridSearch` vs. `contextHybrid` w/ disk read)
 * - B4:    Embedded offline Retrieval Quality & Symbol Lookup evaluation (`runEvaluationSuite`).
 * - B5:    Statistical aggregation (`min`, `p50`/median, `mean`, `p95`, `p99`, `sd`, `cvPct`, `ci95`).
 * - B6/B7: Versioned JSON baseline (`benchmarks/baseline.json`), human-readable Markdown report
 *          (`benchmarks/BASELINE_REPORT.md`), and noise-aware regression comparison.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 1. Non-Intrusive Filesystem I/O Instrumentation (installed before dist/ import)
// ============================================================================
const ioCounters = {
  active: false,
  dirsWalked: 0,
  filesStatted: 0,
  filesRead: 0,
  bytesRead: 0,
  filesWritten: 0,
  bytesWritten: 0,
  uniqueFilesRead: new Set(),
  uniqueFilesStatted: new Set(),
};

function resetIoCounters() {
  ioCounters.dirsWalked = 0;
  ioCounters.filesStatted = 0;
  ioCounters.filesRead = 0;
  ioCounters.bytesRead = 0;
  ioCounters.filesWritten = 0;
  ioCounters.bytesWritten = 0;
  ioCounters.uniqueFilesRead.clear();
  ioCounters.uniqueFilesStatted.clear();
}

function snapshotIoCounters() {
  return {
    dirsWalked: ioCounters.dirsWalked,
    filesStatted: ioCounters.filesStatted,
    uniqueFilesStatted: ioCounters.uniqueFilesStatted.size,
    filesRead: ioCounters.filesRead,
    uniqueFilesRead: ioCounters.uniqueFilesRead.size,
    bytesRead: ioCounters.bytesRead,
    filesWritten: ioCounters.filesWritten,
    bytesWritten: ioCounters.bytesWritten,
  };
}

const origReaddirSync = fs.readdirSync.bind(fs);
const origStatSync = fs.statSync.bind(fs);
const origLstatSync = fs.lstatSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);
const origReadSync = fs.readSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);

fs.readdirSync = function instrumentedReaddirSync(p, ...rest) {
  if (ioCounters.active) ioCounters.dirsWalked++;
  return origReaddirSync(p, ...rest);
};

fs.statSync = function instrumentedStatSync(p, ...rest) {
  const res = origStatSync(p, ...rest);
  if (ioCounters.active && typeof p === 'string') {
    ioCounters.filesStatted++;
    ioCounters.uniqueFilesStatted.add(p);
  }
  return res;
};

fs.lstatSync = function instrumentedLstatSync(p, ...rest) {
  const res = origLstatSync(p, ...rest);
  if (ioCounters.active && typeof p === 'string') {
    ioCounters.filesStatted++;
    ioCounters.uniqueFilesStatted.add(p);
  }
  return res;
};

fs.readFileSync = function instrumentedReadFileSync(p, ...rest) {
  const res = origReadFileSync(p, ...rest);
  if (ioCounters.active) {
    ioCounters.filesRead++;
    if (typeof p === 'string') ioCounters.uniqueFilesRead.add(p);
    const bytes = typeof res === 'string' ? Buffer.byteLength(res, 'utf8') : (res?.byteLength ?? 0);
    ioCounters.bytesRead += bytes;
  }
  return res;
};

fs.readSync = function instrumentedReadSync(fd, buffer, ...rest) {
  const bytes = origReadSync(fd, buffer, ...rest);
  if (ioCounters.active) {
    ioCounters.filesRead++;
    ioCounters.bytesRead += bytes;
  }
  return bytes;
};

fs.writeFileSync = function instrumentedWriteFileSync(p, data, ...rest) {
  if (ioCounters.active) {
    ioCounters.filesWritten++;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : (data?.byteLength ?? 0);
    ioCounters.bytesWritten += bytes;
  }
  return origWriteFileSync(p, data, ...rest);
};

syncBuiltinESMExports();

// Dynamically import production build and eval harness AFTER fs hooks are active
const recall = await import('../dist/index.js');
const { runEvaluationSuite } = await import('./eval.js');

const {
  initProject,
  syncPassport,
  where,
  buildSanitizedInjectionContext,
  processLifecycleHookInput,
  agentRemember,
  search,
  hybridSearch,
  contextHybrid,
  loadSearchableMemories,
  getSharedSqliteStore,
  closeSharedSqliteStore,
  costReport,
} = recall;

export const BENCHMARK_SUITE_VERSION = 'recall-bench-v1';
export const DATASET_VERSION = 'recall-bench-ds-v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const benchmarksDir = path.join(repoRoot, 'benchmarks');
const baselineJsonPath = path.join(benchmarksDir, 'baseline.json');
const baselineMdPath = path.join(benchmarksDir, 'BASELINE_REPORT.md');

// ============================================================================
// 2. Statistical Aggregation & Measurement Helpers (B5)
// ============================================================================
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function computeStats(samples) {
  const n = samples.length;
  if (n === 0) {
    return { n: 0, min: 0, p50: 0, mean: 0, p95: 0, p99: 0, max: 0, sd: 0, cvPct: 0, ci95: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const p99 = quantile(sorted, 0.99);
  const variance = n > 1 ? samples.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const cvPct = mean > 0 ? (sd / mean) * 100 : 0;
  const ci95 = n > 1 ? 1.96 * (sd / Math.sqrt(n)) : 0;

  return {
    n,
    min: Number(min.toFixed(3)),
    p50: Number(p50.toFixed(3)),
    mean: Number(mean.toFixed(3)),
    p95: Number(p95.toFixed(3)),
    p99: Number(p99.toFixed(3)),
    max: Number(max.toFixed(3)),
    sd: Number(sd.toFixed(3)),
    cvPct: Number(cvPct.toFixed(1)),
    ci95: Number(ci95.toFixed(3)),
  };
}

function measureWorkload(fn, { iterations = 15, warmup = 2, beforeEach } = {}) {
  for (let w = 0; w < warmup; w++) {
    if (beforeEach) beforeEach(w, true);
    fn(w, true);
  }

  const wallSamples = [];
  const cpuSamples = [];
  let lastIo = null;
  let lastResult = null;
  const heapBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < iterations; i++) {
    if (beforeEach) beforeEach(i, false);
    resetIoCounters();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    ioCounters.active = true;
    try {
      lastResult = fn(i, false);
    } finally {
      ioCounters.active = false;
    }
    const wallMs = performance.now() - t0;
    const cpuDelta = process.cpuUsage(cpu0);
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    wallSamples.push(wallMs);
    cpuSamples.push(cpuMs);
    lastIo = snapshotIoCounters();
  }

  const heapAfter = process.memoryUsage().heapUsed;
  return {
    latencyMs: computeStats(wallSamples),
    cpuMs: computeStats(cpuSamples),
    ioPerOp: lastIo,
    heapDeltaKb: Math.round((heapAfter - heapBefore) / 1024),
    lastResult,
  };
}

// ============================================================================
// 3. Deterministic Multi-Scale Project Fixture Generator (B2)
// ============================================================================
const DOMAINS = [
  'auth', 'billing', 'cache', 'config', 'crypto', 'database', 'events', 'exporter',
  'gateway', 'health', 'identity', 'indexer', 'jobs', 'ledger', 'logging', 'metrics',
  'notifications', 'parser', 'permissions', 'queue', 'ratelimit', 'routing', 'search',
  'security', 'storage',
];

function generateDeterministicSourceFile(domain, fileIdx, linesTarget = 120) {
  const pascalDomain = domain.charAt(0).toUpperCase() + domain.slice(1);
  const className = `${pascalDomain}Controller${fileIdx}`;
  const ifaceName = `${pascalDomain}Config${fileIdx}`;
  const fnName = `execute${pascalDomain}Workflow${fileIdx}`;
  const helperMethod = `validate${pascalDomain}Payload${fileIdx}`;
  const syncMethod = `commit${pascalDomain}StateSync${fileIdx}`;
  const constName = `DEFAULT_${domain.toUpperCase()}_TIMEOUT_${fileIdx}`;

  const lines = [
    `// Deterministic fixture module: ${domain}/module-${fileIdx}.ts`,
    `export const ${constName} = ${1000 + fileIdx * 50};`,
    '',
    `export interface ${ifaceName} {`,
    `  tenantId: string;`,
    `  timeoutMs: number;`,
    `  strictMode: boolean;`,
    `}`,
    '',
    `export function ${fnName}(input: string, cfg: ${ifaceName}): string {`,
    `  const normalized = input.trim().toLowerCase();`,
    `  if (!normalized && cfg.strictMode) {`,
    `    throw new Error("Empty input in ${domain} workflow ${fileIdx}");`,
    `  }`,
    `  return \`\${cfg.tenantId}:\${normalized}:\${cfg.timeoutMs}\`;`,
    `}`,
    '',
    `export class ${className} {`,
    `  constructor(private readonly config: ${ifaceName}) {}`,
    '',
    `  async processRequest(payload: Record<string, unknown>): Promise<boolean> {`,
    `    return this.${helperMethod}(payload) && this.config.timeoutMs > 0;`,
    `  }`,
    '',
    `  ${syncMethod}(recordId: string): string {`,
    `    return \`committed:\${recordId}\`;`,
    `  }`,
    '',
    `  private ${helperMethod}(payload: Record<string, unknown>): boolean {`,
    `    return typeof payload === "object" && payload !== null;`,
    `  }`,
  ];

  let step = 1;
  while (lines.length < linesTarget - 2) {
    lines.push(
      `  // Landmark padding section ${step} for deterministic line count`,
      `  computeStep${step}Metric(val: number): number { return val * ${step} + ${fileIdx}; }`,
    );
    step++;
  }
  lines.push('}', '');
  return lines.join('\n');
}

function buildProjectFixture(baseDir, tier) {
  const specs = {
    small: { filesCount: 15, linesPerFile: 90, memoriesCount: 12 },
    medium: { filesCount: 80, linesPerFile: 150, memoriesCount: 30 },
    large: { filesCount: 240, linesPerFile: 170, memoriesCount: 60 },
  };
  const spec = specs[tier] ?? specs.medium;
  const root = path.join(baseDir, `fixture-${tier}`);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: `@bench/recall-fixture-${tier}`,
        version: '1.0.0',
        description: `Deterministic ${tier} benchmark project fixture (${spec.filesCount} source files).`,
        type: 'module',
        engines: { node: '>=20' },
        dependencies: { zod: '^3.23.8', commander: '^12.1.0' },
        scripts: {
          build: 'tsc -p tsconfig.json',
          typecheck: 'tsc --noEmit',
          test: 'node --test',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, '.gitignore'),
    'node_modules/\ndist/\ncoverage/\n.env\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(root, 'README.md'),
    `# Recall Fixture (${tier})\n\nDeterministic multi-module architecture fixture for application benchmarking.\n`,
    'utf8',
  );

  const createdFiles = [];
  for (let i = 0; i < spec.filesCount; i++) {
    const domain = DOMAINS[i % DOMAINS.length];
    const dir = path.join(root, 'src', domain);
    fs.mkdirSync(dir, { recursive: true });
    const rel = `src/${domain}/module-${i}.ts`;
    const lineCount = i % 5 === 0 ? spec.linesPerFile * 2 : spec.linesPerFile;
    fs.writeFileSync(
      path.join(root, rel),
      generateDeterministicSourceFile(domain, i, lineCount),
      'utf8',
    );
    createdFiles.push(rel);
  }

  // Add a test file that should be ignored by production scanners
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tests', 'fixture.test.ts'),
    'export function ignoredTestHelper() { return true; }\n',
    'utf8',
  );

  return { root, spec, createdFiles };
}

function getEnvironmentMetadata() {
  let gitSha = 'unknown';
  let gitDirty = false;
  try {
    gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    gitDirty = statusOut.length > 0;
  } catch {
    // ignore if git unavailable
  }

  return {
    suiteVersion: BENCHMARK_SUITE_VERSION,
    datasetVersion: DATASET_VERSION,
    timestamp: new Date().toISOString(),
    gitCommit: gitSha,
    gitDirty,
    cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
    cpuCores: os.cpus().length,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    totalMemGb: Number((os.totalmem() / (1024 ** 3)).toFixed(1)),
  };
}

// ============================================================================
// 4. Execute Full Benchmark Suite
// ============================================================================
const args = process.argv.slice(2);
const saveBaselineFlag = args.includes('--save-baseline') || !fs.existsSync(baselineJsonPath);

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-bench-v1-'));
const envMeta = getEnvironmentMetadata();

console.log('============================================================================');
console.log(`  RECALL APPLICATION BENCHMARK SUITE (${BENCHMARK_SUITE_VERSION})`);
console.log('============================================================================');
console.log(`  CPU:      ${envMeta.cpuModel} (${envMeta.cpuCores} cores)`);
console.log(`  OS:       ${envMeta.os} | RAM: ${envMeta.totalMemGb} GB`);
console.log(`  Runtime:  Node.js ${envMeta.nodeVersion}`);
console.log(`  Commit:   ${envMeta.gitCommit}${envMeta.gitDirty ? ' (dirty)' : ''} | Dataset: ${envMeta.datasetVersion}`);
console.log('----------------------------------------------------------------------------');

const report = {
  metadata: envMeta,
  fixtureScaling: {},
  workloads: {},
  retrievalEvaluation: null,
  tokenFootprint: null,
};

try {
  // --------------------------------------------------------------------------
  // A. Multi-Scale Initial Indexing (`initProject` across Small, Medium, Large)
  // --------------------------------------------------------------------------
  console.log('\n[1/6] Multi-Scale Initial Indexing (`initProject` on Small / Medium / Large Fixtures):');
  const fixtures = {};
  for (const tier of ['small', 'medium', 'large']) {
    const fx = buildProjectFixture(tmpBase, tier);
    fixtures[tier] = fx;

    resetIoCounters();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    ioCounters.active = true;
    try {
      initProject(fx.root, { allAgents: true });
    } finally {
      ioCounters.active = false;
    }
    const wallMs = Number((performance.now() - t0).toFixed(2));
    const cpuDelta = process.cpuUsage(cpu0);
    const cpuMs = Number(((cpuDelta.user + cpuDelta.system) / 1000).toFixed(2));
    const io = snapshotIoCounters();

    report.fixtureScaling[tier] = {
      sourceFiles: fx.spec.filesCount,
      wallMs,
      cpuMs,
      io,
    };

    console.log(
      `  - ${tier.padEnd(6)} (${String(fx.spec.filesCount).padStart(3)} files): ${String(wallMs).padStart(7)} ms | dirsWalked=${io.dirsWalked} | filesStatted=${io.filesStatted} | filesRead=${io.filesRead} (${(io.bytesRead / 1024).toFixed(1)} KB) | writes=${io.filesWritten}`,
    );
  }

  // Use Medium fixture (80 source files) as primary interactive application workload
  const medRoot = fixtures.medium.root;
  const medRecallDir = path.join(medRoot, '.recall');

  // Seed 30 active memories into Medium fixture (measuring write scaling N=1..30)
  console.log('\n[2/6] Memory Write Scaling (`agentRemember` N=1..30 on Medium 80-file Repo):');
  const writeSamplesFirst5 = [];
  const writeSamplesLast5 = [];
  let firstWriteIo = null;
  let lastWriteIo = null;

  for (let i = 1; i <= 30; i++) {
    resetIoCounters();
    const t0 = performance.now();
    ioCounters.active = true;
    try {
      agentRemember(medRoot, {
        title: `Architecture decision ${i} for ${DOMAINS[i % DOMAINS.length]} module`,
        type: i % 3 === 0 ? 'bugfix' : i % 2 === 0 ? 'convention' : 'decision',
        tags: [DOMAINS[i % DOMAINS.length], i % 2 === 0 ? 'security' : 'performance', `tier_${i % 5}`],
        text: `Enforce strict timeout and payload validation in src/${DOMAINS[i % DOMAINS.length]}/module-${i}.ts using executeWorkflow${i}.`,
      });
    } finally {
      ioCounters.active = false;
    }
    const elapsed = performance.now() - t0;
    if (i <= 5) {
      writeSamplesFirst5.push(elapsed);
      if (i === 1) firstWriteIo = snapshotIoCounters();
    }
    if (i > 25) {
      writeSamplesLast5.push(elapsed);
      if (i === 30) lastWriteIo = snapshotIoCounters();
    }
  }

  report.workloads.writeScaling = {
    first5: computeStats(writeSamplesFirst5),
    last5: computeStats(writeSamplesLast5),
    firstWriteIo,
    lastWriteIo,
  };
  console.log(
    `  - Writes N=1..5:   p50=${report.workloads.writeScaling.first5.p50} ms (mean=${report.workloads.writeScaling.first5.mean} ms) | filesRead=${firstWriteIo.filesRead} | dirsWalked=${firstWriteIo.dirsWalked}`,
  );
  console.log(
    `  - Writes N=26..30: p50=${report.workloads.writeScaling.last5.p50} ms (mean=${report.workloads.writeScaling.last5.mean} ms) | filesRead=${lastWriteIo.filesRead} | dirsWalked=${lastWriteIo.dirsWalked}`,
  );

  // --------------------------------------------------------------------------
  // B. Lifecycle Hook Workloads (SessionStart Cold/Warm & Stop Hook Mutations)
  // --------------------------------------------------------------------------
  console.log('\n[3/6] Lifecycle Hook & Incremental Sync Workloads (Medium 80-file, 30-memory Repo):');

  const injCachePath = path.join(medRecallDir, '.cache', 'injection-cache.json');

  // 1. Cold SessionStart Hook
  const sessionStartCold = measureWorkload(
    () => {
      const out = processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-sess-cold',
          workspacePaths: [medRoot],
          hookEventName: 'SessionStart',
          lastUserInput: 'check timeout validation in auth module',
        }),
        medRoot,
      );
      return out;
    },
    {
      iterations: 12,
      warmup: 2,
      beforeEach: () => {
        if (fs.existsSync(injCachePath)) origWriteFileSync(injCachePath, '{}', 'utf8');
      },
    },
  );
  const coldMsg = JSON.parse(sessionStartCold.lastResult)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? '';
  sessionStartCold.tokensProduced = Math.ceil(coldMsg.length / 4);
  delete sessionStartCold.lastResult;

  // 2. Warm SessionStart Hook
  const sessionStartWarm = measureWorkload(
    () =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-sess-warm',
          workspacePaths: [medRoot],
          hookEventName: 'SessionStart',
        }),
        medRoot,
      ),
    { iterations: 25, warmup: 3 },
  );
  const warmMsg = JSON.parse(sessionStartWarm.lastResult)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? '';
  sessionStartWarm.tokensProduced = Math.ceil(warmMsg.length / 4);
  delete sessionStartWarm.lastResult;

  // 3. Stop Hook on Unchanged Project (Idle Q&A Turn)
  const stopUnchanged = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-stop-unchanged',
          workspacePaths: [medRoot],
          hookEventName: 'Stop',
          lastUserInput: `Question ${iter}: how does auth validation work?`,
          response: `Answer ${iter}: Auth validation uses executeAuthWorkflow0 with strictMode.`,
          modelName: 'Gemini 4',
        }),
        medRoot,
      ),
    { iterations: 12, warmup: 2 },
  );
  delete stopUnchanged.lastResult;

  // 4. Stop Hook after 1-File Modification
  const target1File = path.join(medRoot, 'src', 'auth', 'module-0.ts');
  const orig1Content = origReadFileSync(target1File, 'utf8');
  const stopOneFileModified = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-stop-1file',
          workspacePaths: [medRoot],
          hookEventName: 'Stop',
          lastUserInput: `Edit 1 file iteration ${iter} in src/auth/module-0.ts`,
          response: `Updated src/auth/module-0.ts in iteration ${iter}.`,
          modelName: 'Gemini 4',
        }),
        medRoot,
      ),
    {
      iterations: 12,
      warmup: 2,
      beforeEach: (iter) => {
        origWriteFileSync(target1File, `${orig1Content}\n// Modified in iter ${iter}\n`, 'utf8');
      },
    },
  );
  origWriteFileSync(target1File, orig1Content, 'utf8');
  delete stopOneFileModified.lastResult;

  // 5. Stop Hook after Multi-File (5 files) Modification
  const multiTargets = fixtures.medium.createdFiles.slice(0, 5).map((rel) => ({
    abs: path.join(medRoot, rel),
    orig: origReadFileSync(path.join(medRoot, rel), 'utf8'),
  }));
  const stopMultiFileModified = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-stop-5files',
          workspacePaths: [medRoot],
          hookEventName: 'Stop',
          lastUserInput: `Batch edit 5 files iteration ${iter}`,
          response: `Completed 5-file update iteration ${iter}.`,
          modelName: 'Gemini 4',
        }),
        medRoot,
      ),
    {
      iterations: 10,
      warmup: 1,
      beforeEach: (iter) => {
        for (const t of multiTargets) {
          origWriteFileSync(t.abs, `${t.orig}\n// Multi-edit iter ${iter}\n`, 'utf8');
        }
      },
    },
  );
  for (const t of multiTargets) origWriteFileSync(t.abs, t.orig, 'utf8');
  delete stopMultiFileModified.lastResult;

  // 6. Stop Hook after File Rename & File Delete
  const renameSrc = path.join(medRoot, 'src', 'auth', 'temp-rename-src.ts');
  const renameDst = path.join(medRoot, 'src', 'auth', 'temp-rename-dst.ts');
  const stopRenameDelete = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-stop-rename',
          workspacePaths: [medRoot],
          hookEventName: 'Stop',
          lastUserInput: `Renamed file iteration ${iter}`,
          response: `Renamed temp-rename-src.ts and cleaned up old module.`,
        }),
        medRoot,
      ),
    {
      iterations: 10,
      warmup: 1,
      beforeEach: (iter) => {
        if (fs.existsSync(renameDst)) fs.rmSync(renameDst, { force: true });
        origWriteFileSync(renameSrc, `export function tempRenamedFn${iter}() { return ${iter}; }\n`, 'utf8');
        fs.renameSync(renameSrc, renameDst);
      },
    },
  );
  if (fs.existsSync(renameDst)) fs.rmSync(renameDst, { force: true });
  delete stopRenameDelete.lastResult;

  // 7. Dependency / package.json Change (`syncPassport`)
  const pkgFile = path.join(medRoot, 'package.json');
  const origPkg = origReadFileSync(pkgFile, 'utf8');
  const depChangePassport = measureWorkload(
    () => syncPassport(medRoot, medRecallDir),
    {
      iterations: 12,
      warmup: 2,
      beforeEach: (iter) => {
        const parsed = JSON.parse(origPkg);
        parsed.dependencies[`dep-extra-${iter}`] = '^1.0.0';
        origWriteFileSync(pkgFile, JSON.stringify(parsed, null, 2), 'utf8');
      },
    },
  );
  origWriteFileSync(pkgFile, origPkg, 'utf8');
  delete depChangePassport.lastResult;

  report.workloads.sessionStartCold = sessionStartCold;
  report.workloads.sessionStartWarm = sessionStartWarm;
  report.workloads.stopUnchanged = stopUnchanged;
  report.workloads.stopOneFileModified = stopOneFileModified;
  report.workloads.stopMultiFileModified = stopMultiFileModified;
  report.workloads.stopRenameDelete = stopRenameDelete;
  report.workloads.depChangePassport = depChangePassport;

  const printWl = (label, wl) => {
    const io = wl.ioPerOp;
    console.log(
      `  - ${label.padEnd(32)}: p50=${String(wl.latencyMs.p50).padStart(6)}ms | p95=${String(wl.latencyMs.p95).padStart(6)}ms | dirsWalked=${String(io.dirsWalked).padStart(3)} | statted=${String(io.filesStatted).padStart(3)} | filesRead=${String(io.filesRead).padStart(3)} (${(io.bytesRead / 1024).toFixed(1)} KB) | writes=${io.filesWritten}`,
    );
  };

  printWl('SessionStart (Cold + query)', sessionStartCold);
  printWl('SessionStart (Warm cache)', sessionStartWarm);
  printWl('Stop Hook (0 files changed)', stopUnchanged);
  printWl('Stop Hook (1 file modified)', stopOneFileModified);
  printWl('Stop Hook (5 files modified)', stopMultiFileModified);
  printWl('Stop Hook (File rename/delete)', stopRenameDelete);
  printWl('Dependency change (syncPassport)', depChangePassport);

  // --------------------------------------------------------------------------
  // B2. Real Git Repository Fast-Path Verification (80-file Git Repo)
  // --------------------------------------------------------------------------
  console.log('\n[3b/6] Real Git Repository Fast-Path Benchmark (80-file Committed Git Repo):');
  const gitFx = buildProjectFixture(path.join(tmpBase, 'git-bench'), 'medium');
  const gitRoot = gitFx.root;
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd: gitRoot,
      stdio: 'ignore',
      windowsHide: true,
    });

  runGit(['init']);
  runGit(['config', 'user.email', 'bench@recall.local']);
  runGit(['config', 'user.name', 'Recall Bench']);
  initProject(gitRoot);
  runGit(['add', '.']);
  runGit(['commit', '-m', 'Initial fixture commit']);
  // Warm up gitHead in fingerprint.json after initial commit
  processLifecycleHookInput(
    JSON.stringify({
      conversationId: 'bench-git-warmup',
      workspacePaths: [gitRoot],
      hookEventName: 'Stop',
      lastUserInput: 'Initial sync after commit',
      response: 'Synced initial git HEAD.',
    }),
    gitRoot,
  );

  const stopGitClean = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-git-clean',
          workspacePaths: [gitRoot],
          hookEventName: 'Stop',
          lastUserInput: `Clean git Q&A turn ${iter}: explain architecture`,
          response: `Clean git reply ${iter}.`,
        }),
        gitRoot,
      ),
    { iterations: 12, warmup: 2 },
  );
  delete stopGitClean.lastResult;

  const gitTargetFile = path.join(gitRoot, 'src', 'auth', 'module-0.ts');
  const gitTargetOrig = origReadFileSync(gitTargetFile, 'utf8');
  const stopGitOneFileModified = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-git-1file',
          workspacePaths: [gitRoot],
          hookEventName: 'Stop',
          lastUserInput: `Edited 1 file in git repo iter ${iter}`,
          response: `Done editing iter ${iter}.`,
        }),
        gitRoot,
      ),
    {
      iterations: 12,
      warmup: 2,
      beforeEach: (iter) => {
        origWriteFileSync(gitTargetFile, `${gitTargetOrig}\n// Git edit iter ${iter}\n`, 'utf8');
      },
    },
  );
  origWriteFileSync(gitTargetFile, gitTargetOrig, 'utf8');
  delete stopGitOneFileModified.lastResult;

  const gitUntrackedFile = path.join(gitRoot, 'src', 'auth', 'untracked-feature.ts');
  const stopGitUntrackedAdded = measureWorkload(
    (iter) =>
      processLifecycleHookInput(
        JSON.stringify({
          conversationId: 'bench-git-untracked',
          workspacePaths: [gitRoot],
          hookEventName: 'Stop',
          lastUserInput: `Added untracked helper iter ${iter}`,
          response: `Created helper iter ${iter}.`,
        }),
        gitRoot,
      ),
    {
      iterations: 10,
      warmup: 1,
      beforeEach: (iter) => {
        origWriteFileSync(
          gitUntrackedFile,
          `export function untrackedHelper${iter}(x: number): number { return x + ${iter}; }\n`,
          'utf8',
        );
      },
    },
  );
  if (fs.existsSync(gitUntrackedFile)) fs.rmSync(gitUntrackedFile, { force: true });
  delete stopGitUntrackedAdded.lastResult;

  report.workloads.stopGitClean = stopGitClean;
  report.workloads.stopGitOneFileModified = stopGitOneFileModified;
  report.workloads.stopGitUntrackedAdded = stopGitUntrackedAdded;

  printWl('Stop Hook [GIT Clean / 0 chg]', stopGitClean);
  printWl('Stop Hook [GIT Dirty / 1 mod]', stopGitOneFileModified);
  printWl('Stop Hook [GIT Dirty / +1 new]', stopGitUntrackedAdded);

  // --------------------------------------------------------------------------
  // C. Symbol Lookup (`where` Cold vs. Warm) & Context Retrieval I/O
  // --------------------------------------------------------------------------
  console.log('\n[4/6] Symbol Lookup (`where`) & Context Retrieval Latency / I/O:');
  const landmarksCachePath = path.join(medRecallDir, '.cache', 'landmarks-cache.json');

  const whereCold = measureWorkload(
    () => where(medRoot, medRecallDir, 'executeAuthWorkflow0'),
    {
      iterations: 10,
      warmup: 1,
      beforeEach: () => {
        if (fs.existsSync(landmarksCachePath)) fs.rmSync(landmarksCachePath, { force: true });
      },
    },
  );
  delete whereCold.lastResult;

  const whereWarm = measureWorkload(
    () => where(medRoot, medRecallDir, 'executeAuthWorkflow0'),
    { iterations: 20, warmup: 3 },
  );
  delete whereWarm.lastResult;

  const allMemories = loadSearchableMemories(medRecallDir);
  const store = getSharedSqliteStore(medRecallDir);
  store.ensureSynced(allMemories);

  const retrievalKeywordInMem = measureWorkload(
    () => search(allMemories, 'strict timeout payload validation executeWorkflow'),
    { iterations: 50, warmup: 5 },
  );
  delete retrievalKeywordInMem.lastResult;

  const retrievalHybridInMem = measureWorkload(
    () => hybridSearch(allMemories, 'strict timeout payload validation executeWorkflow', { sqliteStore: store }),
    { iterations: 50, warmup: 5 },
  );
  delete retrievalHybridInMem.lastResult;

  const retrievalContextHybridDisk = measureWorkload(
    () => contextHybrid(medRoot, 'strict timeout payload validation executeWorkflow'),
    { iterations: 20, warmup: 3 },
  );
  delete retrievalContextHybridDisk.lastResult;

  report.workloads.whereCold = whereCold;
  report.workloads.whereWarm = whereWarm;
  report.workloads.retrievalKeywordInMem = retrievalKeywordInMem;
  report.workloads.retrievalHybridInMem = retrievalHybridInMem;
  report.workloads.retrievalContextHybridDisk = retrievalContextHybridDisk;

  printWl('where() Cold (cache build)', whereCold);
  printWl('where() Warm (cache hit)', whereWarm);
  printWl('search() (In-memory keyword)', retrievalKeywordInMem);
  printWl('hybridSearch() (In-mem + SQLite)', retrievalHybridInMem);
  printWl('contextHybrid() (Disk + SQLite)', retrievalContextHybridDisk);

  // --------------------------------------------------------------------------
  // D. Retrieval Quality & Symbol Lookup Evaluation (B4)
  // --------------------------------------------------------------------------
  console.log('\n[5/6] Offline Retrieval Quality & Symbol Lookup Coverage (B4):');
  const evalReport = runEvaluationSuite({ silent: true });
  report.retrievalEvaluation = evalReport;

  for (const [mode, mRep] of Object.entries(evalReport.modes)) {
    console.log(
      `  - ${mode.padEnd(16)}: Recall@1=${String(mRep.recallAt1Pct + '%').padStart(6)} | Recall@3=${String(mRep.recallAt3Pct + '%').padStart(6)} | Prec@3=${String(mRep.precisionAt3Pct + '%').padStart(6)} | MRR=${mRep.mrr.toFixed(3)} | nDCG@3=${mRep.ndcgAt3.toFixed(3)} | Leaks=${mRep.distractorLeakRatePct}%`,
    );
  }
  console.log(
    `  - Symbol Lookup (whereIs): Recall@1=${evalReport.symbolLookup.hitsAt1}/${evalReport.symbolLookup.totalTargets} (${evalReport.symbolLookup.recallAt1Pct}%) | Recall@5=${evalReport.symbolLookup.hitsAt5}/${evalReport.symbolLookup.totalTargets} (${evalReport.symbolLookup.recallAt5Pct}%) | Missing categories=${evalReport.symbolLookup.missingTargets.length}`,
  );

  // --------------------------------------------------------------------------
  // E. Token Cost Footprint
  // --------------------------------------------------------------------------
  console.log('\n[6/6] Token Footprint Verification (`costReport`):');
  const cost = costReport(medRoot);
  const onDemandTotal = cost.onDemand.reduce((s, x) => s + x.tokens, 0);
  report.tokenFootprint = {
    alwaysOnTotal: cost.alwaysOnTotal,
    alwaysOnBudget: 120,
    alwaysOnPass: cost.alwaysOnTotal <= 120,
    onDemandTotal,
    onDemandBreakdown: cost.onDemand,
    warnings: cost.warnings,
  };
  console.log(`  - Always-on tokens: ${cost.alwaysOnTotal} / 120 budget (${cost.alwaysOnTotal <= 120 ? 'PASS' : 'FAIL'})`);
  console.log(`  - On-demand tokens: ${onDemandTotal} across ${cost.onDemand.length} files | Warnings: ${cost.warnings.length}`);

  // --------------------------------------------------------------------------
  // F. Historical Baseline Comparison & Report Generation (B6 & B7)
  // --------------------------------------------------------------------------
  fs.mkdirSync(benchmarksDir, { recursive: true });

  const regressions = [];
  const improvements = [];

  if (fs.existsSync(baselineJsonPath) && !args.includes('--save-baseline')) {
    try {
      const baseline = JSON.parse(origReadFileSync(baselineJsonPath, 'utf8'));
      const compareMetric = (name, currVal, baseVal, { lowerIsBetter = true, isExactIo = false } = {}) => {
        if (typeof currVal !== 'number' || typeof baseVal !== 'number' || baseVal === 0) return;
        const delta = currVal - baseVal;
        const pct = (delta / baseVal) * 100;
        if (isExactIo) {
          if (lowerIsBetter && delta > 0) {
            regressions.push(`${name}: increased from ${baseVal} to ${currVal} (+${ pct.toFixed(1)}%)`);
          } else if (lowerIsBetter && delta < 0) {
            improvements.push(`${name}: reduced from ${baseVal} to ${currVal} (${pct.toFixed(1)}%)`);
          } else if (!lowerIsBetter && delta < 0) {
            regressions.push(`${name}: dropped from ${baseVal} to ${currVal} (${pct.toFixed(1)}%)`);
          } else if (!lowerIsBetter && delta > 0) {
            improvements.push(`${name}: improved from ${baseVal} to ${currVal} (+${pct.toFixed(1)}%)`);
          }
        } else {
          // Noise-aware timing threshold: >20% AND >5ms absolute shift
          if (lowerIsBetter && pct > 20 && delta > 5) {
            regressions.push(`${name} (p50): ${baseVal}ms -> ${currVal}ms (+${pct.toFixed(1)}%)`);
          } else if (lowerIsBetter && pct < -15 && Math.abs(delta) > 3) {
            improvements.push(`${name} (p50): ${baseVal}ms -> ${currVal}ms (${pct.toFixed(1)}%)`);
          }
        }
      };

      for (const [wlKey, currWl] of Object.entries(report.workloads)) {
        const baseWl = baseline.workloads?.[wlKey];
        if (!baseWl || !currWl.latencyMs || !baseWl.latencyMs) continue;
        compareMetric(`${wlKey}.latency`, currWl.latencyMs.p50, baseWl.latencyMs.p50, { lowerIsBetter: true });
        if (currWl.ioPerOp && baseWl.ioPerOp) {
          compareMetric(`${wlKey}.dirsWalked`, currWl.ioPerOp.dirsWalked, baseWl.ioPerOp.dirsWalked, { lowerIsBetter: true, isExactIo: true });
          compareMetric(`${wlKey}.filesStatted`, currWl.ioPerOp.filesStatted, baseWl.ioPerOp.filesStatted, { lowerIsBetter: true, isExactIo: true });
          compareMetric(`${wlKey}.filesRead`, currWl.ioPerOp.filesRead, baseWl.ioPerOp.filesRead, { lowerIsBetter: true, isExactIo: true });
        }
      }

      const currProd = report.retrievalEvaluation.modes.HYBRID_MINMAX;
      const baseProd = baseline.retrievalEvaluation?.modes?.HYBRID_MINMAX;
      if (currProd && baseProd) {
        compareMetric('HYBRID_MINMAX.ndcgAt3', currProd.ndcgAt3, baseProd.ndcgAt3, { lowerIsBetter: false, isExactIo: true });
        compareMetric('HYBRID_MINMAX.recallAt3Pct', currProd.recallAt3Pct, baseProd.recallAt3Pct, { lowerIsBetter: false, isExactIo: true });
      }
      compareMetric(
        'symbolLookup.recallAt5Pct',
        report.retrievalEvaluation.symbolLookup.recallAt5Pct,
        baseline.retrievalEvaluation?.symbolLookup?.recallAt5Pct,
        { lowerIsBetter: false, isExactIo: true },
      );
    } catch {
      // ignore unreadable baseline
    }
  }

  report.comparison = { regressions, improvements };

  if (saveBaselineFlag) {
    origWriteFileSync(baselineJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nSaved reproducible baseline JSON -> ${baselineJsonPath}`);
  }

  const latestJsonPath = path.join(benchmarksDir, 'latest.json');
  origWriteFileSync(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // Generate readable Markdown report (B7)
  const mdLines = [
    `# Recall Application Benchmark Baseline Report (${BENCHMARK_SUITE_VERSION})`,
    '',
    `> **Generated**: \`${envMeta.timestamp}\` · **Commit**: \`${envMeta.gitCommit}${envMeta.gitDirty ? ' (dirty)' : ''}\` · **Dataset**: \`${envMeta.datasetVersion}\``,
    `> **Environment**: ${envMeta.cpuModel} (${envMeta.cpuCores} cores) · ${envMeta.os} · Node.js ${envMeta.nodeVersion}`,
    '',
    '## 1. Multi-Scale Initial Indexing (`initProject`)',
    '',
    '| Fixture Tier | Source Files | Wall Time (ms) | CPU Time (ms) | Dirs Walked | Files Statted | Files Read | Bytes Read (KB) | Files Written |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const [tier, fx] of Object.entries(report.fixtureScaling)) {
    mdLines.push(
      `| **${tier}** | ${fx.sourceFiles} | ${fx.wallMs} | ${fx.cpuMs} | ${fx.io.dirsWalked} | ${fx.io.filesStatted} | ${fx.io.filesRead} | ${(fx.io.bytesRead / 1024).toFixed(1)} | ${fx.io.filesWritten} |`,
    );
  }

  mdLines.push(
    '',
    '## 2. Lifecycle Hook & Incremental Sync Workloads (Medium 80-File, 30-Memory Project)',
    '',
    '| Workload | p50 (ms) | Mean (ms) | p95 (ms) | SD (±ms) | CV% | Dirs Walked | Files Statted | Files Read | Bytes Read (KB) | Files Written |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  const wlLabels = [
    ['sessionStartCold', 'SessionStart Hook (Cold + Query)'],
    ['sessionStartWarm', 'SessionStart Hook (Warm Cache)'],
    ['stopUnchanged', 'Stop Hook (0 Files Changed / Q&A Turn)'],
    ['stopOneFileModified', 'Stop Hook (1 File Modified)'],
    ['stopMultiFileModified', 'Stop Hook (5 Files Modified)'],
    ['stopRenameDelete', 'Stop Hook (File Rename / Delete)'],
    ['depChangePassport', 'Dependency Change (`syncPassport`)'],
    ['whereCold', '`where()` Symbol Lookup (Cold Cache)'],
    ['whereWarm', '`where()` Symbol Lookup (Warm Cache)'],
    ['retrievalKeywordInMem', '`search()` Keyword (In-Memory)'],
    ['retrievalHybridInMem', '`hybridSearch()` (In-Memory + SQLite)'],
    ['retrievalContextHybridDisk', '`contextHybrid()` (End-to-End w/ Disk Read)'],
  ];

  for (const [key, title] of wlLabels) {
    const wl = report.workloads[key];
    if (!wl) continue;
    const l = wl.latencyMs;
    const io = wl.ioPerOp;
    mdLines.push(
      `| ${title} | **${l.p50}** | ${l.mean} | ${l.p95} | ${l.sd} | ${l.cvPct}% | ${io.dirsWalked} | ${io.filesStatted} | ${io.filesRead} | ${(io.bytesRead / 1024).toFixed(1)} | ${io.filesWritten} |`,
    );
  }

  const ws = report.workloads.writeScaling;
  mdLines.push(
    '',
    '## 3. Memory Persistence Scaling (`agentRemember` on 80-File Project)',
    '',
    '| Write Window | p50 (ms) | Mean (ms) | p95 (ms) | Dirs Walked / Write | Files Statted / Write | Files Read / Write | Bytes Read (KB) | Files Written / Write |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| **First 5 Writes (N=1..5)** | **${ws.first5.p50}** | ${ws.first5.mean} | ${ws.first5.p95} | ${ws.firstWriteIo.dirsWalked} | ${ws.firstWriteIo.filesStatted} | ${ws.firstWriteIo.filesRead} | ${(ws.firstWriteIo.bytesRead / 1024).toFixed(1)} | ${ws.firstWriteIo.filesWritten} |`,
    `| **Last 5 Writes (N=26..30)** | **${ws.last5.p50}** | ${ws.last5.mean} | ${ws.last5.p95} | ${ws.lastWriteIo.dirsWalked} | ${ws.lastWriteIo.filesStatted} | ${ws.lastWriteIo.filesRead} | ${(ws.lastWriteIo.bytesRead / 1024).toFixed(1)} | ${ws.lastWriteIo.filesWritten} |`,
    '',
    '## 4. Retrieval Quality & Ablation Evaluation (`recall-eval-ds-v1`, 32 Queries)',
    '',
    '| Retrieval Mode | Recall@1 | Recall@3 | Graded Rec@3 | Precision@1 | Precision@3 | MRR | nDCG@3 | nDCG@5 | Unnecessary@3 | Distractor Leaks | Avg Tokens | Latency (ms/q) |',
    '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const [mode, r] of Object.entries(evalReport.modes)) {
    mdLines.push(
      `| **${mode}** | ${r.recallAt1Pct}% | ${r.recallAt3Pct}% | ${r.gradedRecallAt3Pct}% | ${r.precisionAt1Pct}% | ${r.precisionAt3Pct}% | ${r.mrr.toFixed(3)} | **${r.ndcgAt3.toFixed(3)}** | ${r.ndcgAt5.toFixed(3)} | ${r.unnecessaryRateAt3Pct}% | ${r.distractorLeakRatePct}% | ${r.avgContextTokens} | ${r.msPerQuery} |`,
    );
  }

  const sym = evalReport.symbolLookup;
  mdLines.push(
    '',
    '## 5. Symbol & File Lookup Evaluation (`whereIs`, 14 Ground-Truth Targets)',
    '',
    `- **Recall@1**: \`${sym.hitsAt1}/${sym.totalTargets} (${sym.recallAt1Pct}%)\``,
    `- **Recall@5**: \`${sym.hitsAt5}/${sym.totalTargets} (${sym.recallAt5Pct}%)\``,
    `- **MRR**: \`${sym.mrr.toFixed(3)}\``,
  );

  if (sym.missingTargets.length > 0) {
    mdLines.push('', '### Missing Ground-Truth Symbol Categories (Baseline Gaps)');
    for (const g of sym.missingTargets) {
      mdLines.push(`- **[${g.category}]** query=\`"${g.query}"\` $\\rightarrow$ expected \`${g.expected}\` (got: \`${g.got.join(', ') || 'No match'}\`)`);
    }
  }

  mdLines.push(
    '',
    '## 6. Token Footprint (`costReport`)',
    '',
    `- **Always-On Tokens**: \`${report.tokenFootprint.alwaysOnTotal}\` / \`${report.tokenFootprint.alwaysOnBudget}\` budget (\`${report.tokenFootprint.alwaysOnPass ? 'PASS' : 'FAIL'}\`)`,
    `- **On-Demand Tokens**: \`${report.tokenFootprint.onDemandTotal}\` across ${report.tokenFootprint.onDemandBreakdown.length} files`,
    '',
  );

  if (saveBaselineFlag) {
    origWriteFileSync(baselineMdPath, mdLines.join('\n'), 'utf8');
    console.log(`Saved readable baseline report  -> ${baselineMdPath}`);
  }

  if (improvements.length > 0) {
    console.log('\nMeasured Improvements vs. Baseline:');
    for (const imp of improvements) console.log(`  + ${imp}`);
  }
  if (regressions.length > 0) {
    console.log('\nMeasured Regressions vs. Baseline:');
    for (const reg of regressions) console.log(`  ! ${reg}`);
  }

  console.log('============================================================================\n');
} finally {
  closeSharedSqliteStore();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
