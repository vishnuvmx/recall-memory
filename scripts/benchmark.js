#!/usr/bin/env node
/**
 * Recall End-to-End Benchmark Suite (`npm run bench`)
 *
 * Measures real wall-clock latency, scaling, and token budgets across every core subsystem:
 * 1. Project Map generation (`generateProjectMap`) — 5 runs + byte budget check
 * 2. Non-volatile Passport (`syncPassport`) — Cold generation vs. Warm cache hit
 * 3. Symbol Lookup (`where`) — Cold landmark extraction vs. Warm MTime cache hit
 * 4. SessionStart Injection (`buildSanitizedInjectionContext`) — Cold build vs. Cached read
 * 5. Write Scaling (`agentRemember`) — End-to-end write latency from 1 -> 60 memories
 * 6. Retrieval Latency — In-memory `search`, `hybridSearch` (SQLite FTS5 + vectors + expansion), and full disk `contextHybrid`
 * 7. Always-On vs. On-Demand Token Footprint (`costReport`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  initProject,
  generateProjectMap,
  syncPassport,
  where,
  buildSanitizedInjectionContext,
  agentRemember,
  search,
  hybridSearch,
  contextHybrid,
  loadSearchableMemories,
  getSharedSqliteStore,
  closeSharedSqliteStore,
  costReport,
} from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const targetArg = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const variance =
    samples.length > 1
      ? samples.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (samples.length - 1)
      : 0;
  return { min, median, mean, sd: Math.sqrt(variance), max };
}

console.log('====================================================');
console.log('           RECALL BENCHMARK SUITE (v0.4.0)');
console.log('====================================================');
console.log('Hardware Environment:');
console.log(`  CPU:     ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores)`);
console.log(`  OS:      ${os.type()} ${os.release()} ${os.arch()}`);
console.log(`  Runtime: Node.js ${process.version}`);
console.log(`  Target:  ${targetArg}`);
console.log('----------------------------------------------------');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-bench-'));

try {
  // 1. Project Map Generation Latency (5 runs against targetArg)
  console.log('\n[1/7] Project Map Generation (`generateProjectMap`, 5 runs):');
  const mapRuns = [];
  for (let i = 1; i <= 5; i++) {
    const t0 = performance.now();
    generateProjectMap(targetArg, tmpDir);
    const elapsed = performance.now() - t0;
    mapRuns.push(elapsed);
    console.log(`  Run ${i}: ${elapsed.toFixed(2)} ms`);
  }
  const ms = stats(mapRuns);
  const mapPath = path.join(tmpDir, 'PROJECT_MAP.md');
  const mapBytes = fs.existsSync(mapPath) ? Buffer.byteLength(fs.readFileSync(mapPath, 'utf8')) : 0;
  console.log(`  Stats: min=${ms.min.toFixed(2)}ms | median=${ms.median.toFixed(2)}ms | mean=${ms.mean.toFixed(2)}ms (±${ms.sd.toFixed(2)}ms) | max=${ms.max.toFixed(2)}ms`);
  console.log(`  Size:  ${mapBytes} bytes (<= 24000 char standard budget: ${mapBytes <= 24000 ? 'PASS' : 'EXCEEDED'})`);

  // Set up an isolated workspace copying targetArg's src/ for realistic symbol & passport benchmarks
  const workRoot = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workRoot, { recursive: true });
  if (fs.existsSync(path.join(targetArg, 'package.json'))) {
    fs.copyFileSync(path.join(targetArg, 'package.json'), path.join(workRoot, 'package.json'));
  }
  if (fs.existsSync(path.join(targetArg, 'src'))) {
    fs.cpSync(path.join(targetArg, 'src'), path.join(workRoot, 'src'), { recursive: true });
  }

  const initT0 = performance.now();
  initProject(workRoot, { allAgents: true });
  const initElapsed = performance.now() - initT0;
  const workRecallDir = path.join(workRoot, '.recall');

  // 2. Passport Cold vs. Warm Latency
  console.log('\n[2/7] Non-Volatile Blueprint (`syncPassport` Cold vs. Warm):');
  const passColdT0 = performance.now();
  const passCold = syncPassport(workRoot, workRecallDir, { force: true });
  const passColdMs = performance.now() - passColdT0;

  const passWarmT0 = performance.now();
  const passWarm = syncPassport(workRoot, workRecallDir);
  const passWarmMs = performance.now() - passWarmT0;
  console.log(`  initProject (full scaffold + all agents): ${initElapsed.toFixed(2)} ms`);
  console.log(`  Cold syncPassport (forced rebuild):       ${passColdMs.toFixed(2)} ms (updated=${passCold.updated}, ~${passCold.tokensEstimate} tokens)`);
  console.log(`  Warm syncPassport (fingerprint hit):      ${passWarmMs.toFixed(2)} ms (updated=${passWarm.updated})`);

  // 3. Symbol Lookup (`where`) Cold vs. Warm Cache
  console.log('\n[3/7] Symbol & File Lookup (`where` Cold vs. Warm MTime Cache):');
  const landmarksCache = path.join(workRecallDir, '.cache', 'landmarks-cache.json');
  if (fs.existsSync(landmarksCache)) fs.rmSync(landmarksCache);

  const whereColdT0 = performance.now();
  const whereHitsCold = where(workRoot, workRecallDir, 'hybridSearch');
  const whereColdMs = performance.now() - whereColdT0;

  const whereWarmRuns = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    where(workRoot, workRecallDir, 'hybridSearch');
    whereWarmRuns.push(performance.now() - t0);
  }
  const ws = stats(whereWarmRuns);
  console.log(`  Cold where("hybridSearch") [cache build]: ${whereColdMs.toFixed(2)} ms (${whereHitsCold.length} hits)`);
  console.log(`  Warm where("hybridSearch") [10 runs avg]: ${ws.mean.toFixed(2)} ms (median=${ws.median.toFixed(2)}ms)`);

  // 4. Write Path Scaling (`agentRemember` for 60 memories)
  console.log('\n[4/7] End-to-End Write Scaling (`agentRemember` -> Markdown + INDEX + SQLite + PASSPORT):');
  const writeLatencies = [];
  for (let i = 1; i <= 60; i++) {
    const t0 = performance.now();
    agentRemember(workRoot, {
      title: `Architectural decision ${i} for module ${i % 12}`,
      type: i % 3 === 0 ? 'bugfix' : 'decision',
      tags: [`mod_${i % 12}`, i % 2 === 0 ? 'auth' : 'storage', `tag_${i}`],
      text: `Module ${i} enforces isolated validation and atomic state transitions for worker pool ${i % 6}.`,
    });
    writeLatencies.push(performance.now() - t0);
  }
  const first10 = stats(writeLatencies.slice(0, 10));
  const last10 = stats(writeLatencies.slice(50, 60));
  console.log(`  First 10 writes (N=1..10):   mean=${first10.mean.toFixed(2)} ms | median=${first10.median.toFixed(2)} ms`);
  console.log(`  Last 10 writes  (N=51..60):  mean=${last10.mean.toFixed(2)} ms | median=${last10.median.toFixed(2)} ms`);

  // 5. SessionStart Injection Latency (Cold vs. Cached)
  console.log('\n[5/7] Sanitized SessionStart Injection (`buildSanitizedInjectionContext`):');
  const injCache = path.join(workRecallDir, '.cache', 'injection-cache.json');
  if (fs.existsSync(injCache)) fs.rmSync(injCache);

  const injColdT0 = performance.now();
  const injOut = buildSanitizedInjectionContext(workRoot);
  const injColdMs = performance.now() - injColdT0;

  const injWarmRuns = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    buildSanitizedInjectionContext(workRoot);
    injWarmRuns.push(performance.now() - t0);
  }
  const is = stats(injWarmRuns);
  console.log(`  Cold injection build + sanitization: ${injColdMs.toFixed(2)} ms (${injOut.length} chars, ~${Math.ceil(injOut.length / 4)} tokens)`);
  console.log(`  Warm cached injection (20 runs avg): ${is.mean.toFixed(2)} ms (median=${is.median.toFixed(2)} ms)`);

  // 6. Retrieval Latency (In-Memory Keyword vs. Hybrid SQLite/Vector vs. Full Disk Context)
  console.log('\n[6/7] Retrieval Latency (over 60 active memories):');
  const allMemories = loadSearchableMemories(workRecallDir);
  const store = getSharedSqliteStore(workRecallDir);
  store.ensureSynced(allMemories);

  const kwT0 = performance.now();
  for (let i = 0; i < 500; i++) {
    search(allMemories, 'isolated validation atomic state transitions');
  }
  const kwMs = (performance.now() - kwT0) / 500;

  const hybT0 = performance.now();
  for (let i = 0; i < 200; i++) {
    hybridSearch(allMemories, 'isolated validation atomic state transitions', { sqliteStore: store });
  }
  const hybMs = (performance.now() - hybT0) / 200;

  const e2eRuns = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    contextHybrid(workRoot, 'isolated validation atomic state transitions');
    e2eRuns.push(performance.now() - t0);
  }
  const e2e = stats(e2eRuns);
  console.log(`  In-memory keyword search (500 queries):       ${kwMs.toFixed(3)} ms/query`);
  console.log(`  In-memory + SQLite hybridSearch (200 queries): ${hybMs.toFixed(3)} ms/query`);
  console.log(`  End-to-end contextHybrid w/ disk read (20x):   ${e2e.mean.toFixed(2)} ms/query (median=${e2e.median.toFixed(2)} ms)`);

  // 7. Token Cost Footprint on Target Repo
  console.log('\n[7/7] Token Cost Footprint (`costReport` on target repo):');
  try {
    const cost = costReport(targetArg);
    const onDemandTotal = cost.onDemand.reduce((s, x) => s + x.tokens, 0);
    console.log(`  Always-on tokens (injected every turn): ${cost.alwaysOnTotal} tokens (budget <= 120: ${cost.alwaysOnTotal <= 120 ? 'PASS' : 'EXCEEDED'})`);
    console.log(`  On-demand tokens (.recall/ files):      ${onDemandTotal} tokens (${cost.onDemand.length} files)`);
  } catch {
    const costWork = costReport(workRoot);
    const onDemandTotal = costWork.onDemand.reduce((s, x) => s + x.tokens, 0);
    console.log(`  Always-on tokens (workspace):           ${costWork.alwaysOnTotal} tokens`);
    console.log(`  On-demand tokens (workspace):           ${onDemandTotal} tokens`);
  }
} finally {
  closeSharedSqliteStore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n====================================================\n');
