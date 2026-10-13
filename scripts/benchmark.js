import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { generateProjectMap } from '../dist/core/mapper.js';
import { search } from '../dist/core/retrieval.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const targetArg = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;

console.log('====================================================');
console.log('           RECALL BENCHMARK SUITE');
console.log('====================================================');
console.log('Hardware Environment:');
console.log(`  CPU:     ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores)`);
console.log(`  OS:      ${os.type()} ${os.release()} ${os.arch()}`);
console.log(`  Runtime: Node.js ${process.version}`);
console.log(`  Target:  ${targetArg}`);
console.log('----------------------------------------------------');

const tmpDir = path.join(os.tmpdir(), `recall-bench-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  // 1. Unsorted Chronological Mapper Latency (5 runs)
  console.log('\n[1/3] Chronological Map Generation Latency (5 unsorted runs):');
  const runs = [];
  for (let i = 1; i <= 5; i++) {
    const t0 = performance.now();
    generateProjectMap(targetArg, tmpDir);
    const t1 = performance.now();
    const elapsed = t1 - t0;
    runs.push(elapsed);
    console.log(`  Run ${i}: ${elapsed.toFixed(2)} ms`);
  }

  const min = Math.min(...runs);
  const max = Math.max(...runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const sampleVariance = runs.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (runs.length - 1);
  const sampleStdDev = Math.sqrt(sampleVariance);

  console.log(`\n  Summary Statistics:`);
  console.log(`  Min:       ${min.toFixed(2)} ms`);
  console.log(`  Median:    ${median.toFixed(2)} ms`);
  console.log(`  Mean:      ${mean.toFixed(2)} ms (Sample SD s = ±${sampleStdDev.toFixed(2)} ms)`);
  console.log(`  Max:       ${max.toFixed(2)} ms`);

  // 2. Output Size & Budget Check
  const mapPath = path.join(tmpDir, 'PROJECT_MAP.md');
  if (fs.existsSync(mapPath)) {
    const content = fs.readFileSync(mapPath, 'utf8');
    const bytes = Buffer.byteLength(content);
    const lines = content.split('\n').length;
    console.log('\n[2/3] Output Budget Enforcement:');
    console.log(`  Size:  ${bytes.toLocaleString()} bytes (${lines} lines)`);
    console.log(`  Under 6,000-char budget: ${bytes <= 6000 ? 'YES (passed)' : 'NO (exceeded)'}`);
  }

  // 3. Keyword Search Retrieval Latency
  console.log('\n[3/3] Deterministic Keyword Search Latency (1,000 queries):');
  const mockMemories = [];
  for (let i = 0; i < 100; i++) {
    mockMemories.push({
      id: `mem_${String(i).padStart(3, '0')}`,
      title: `Architectural pattern for module ${i} authentication and rendering`,
      type: 'decision',
      status: 'active',
      verification: 'verified',
      tags: ['auth', 'security', 'render', `module_${i}`],
      body: '## Rationale\nStrict token sanitation and deterministic validation rules.',
      file: `decisions/mem_${String(i).padStart(3, '0')}.md`,
    });
  }

  const searchT0 = performance.now();
  for (let q = 0; q < 1000; q++) {
    search(mockMemories, 'jwt token authentication security');
  }
  const searchT1 = performance.now();
  const totalSearch = searchT1 - searchT0;
  console.log(`  1,000 queries completed in: ${totalSearch.toFixed(2)} ms`);
  console.log(`  Average per query:          ${(totalSearch / 1000).toFixed(4)} ms (~${((totalSearch / 1000) * 1000).toFixed(0)} µs)`);

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n====================================================\n');
