import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_BLOCK } from '../src/templates/index.js';
import { TOOLS } from '../src/mcp/server.js';
import { CONTEXT_MAX_CHARS, formatHitsCompact, search } from '../src/core/retrieval.js';
import { agentRemember, checkpoint, context, whereIs } from '../src/core/service.js';
import { initProject } from '../src/core/init.js';
import { costReport, estimateTokens } from '../src/core/cost.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const mk = (opts?: { git?: boolean }): string => {
  const d = tmpProject(opts);
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('token budget guardrails', () => {
  it('enforces always-on instruction block is under 120 tokens (~480 chars)', () => {
    const tokens = estimateTokens(AGENT_BLOCK);
    expect(tokens).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(AGENT_BLOCK)).toBeLessThanOrEqual(480);
  });

  it('enforces MCP tool schemas are under 250 tokens (~1000 chars)', () => {
    const json = JSON.stringify(TOOLS);
    const tokens = estimateTokens(json);
    expect(tokens).toBeLessThanOrEqual(250);
  });

  it('enforces formatHitsCompact caps context output to ~400 tokens (~1600 chars)', () => {
    const root = mk();
    initProject(root);
    for (let i = 1; i <= 10; i++) {
      agentRemember(root, {
        title: `Architecture rule ${i} for authentication token validation`,
        text: `Detailed architectural explanation ${i}: `.repeat(20),
        type: 'decision',
      });
    }

    const hits = context(root, 'authentication token validation', { limit: 10 });
    const rendered = formatHitsCompact(hits);
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(400);
  });

  it('deduplicates near-identical memory writes to prevent context bloat over time', () => {
    const root = mk();
    initProject(root);

    // Initial write
    const r1 = agentRemember(root, {
      title: 'Use atomic writes for config',
      text: 'Always use atomicWrite to prevent corrupt JSON files.',
      type: 'convention',
    });
    expect(r1.action).toBe('created');

    // Repeated write with slightly different title / same intent
    const r2 = agentRemember(root, {
      title: 'Use atomic writes for config files',
      text: 'Always use atomicWrite helper to prevent half-written JSON files.',
      type: 'convention',
    });
    expect(r2.action).toBe('updated');
    expect(r2.memory.id).toBe(r1.memory.id);

    // Context retrieval returns the single consolidated memory, not duplicates
    const hits = context(root, 'atomic writes config');
    expect(hits.length).toBe(1);
    expect(hits[0]!.memory.id).toBe(r1.memory.id);
  });

  it('defaults to autonomous active writes, respects review mode when configured', () => {
    const root = mk();
    initProject(root);

    // Default mode: active
    const rAuto = agentRemember(root, { title: 'Auto active invariant', text: 'no review needed' });
    expect(rAuto.memory.status).toBe('active');

    // Configured with writes: review
    const cfgPath = path.join(root, '.recall', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.writes = 'review';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const rReview = agentRemember(root, { title: 'Review invariant', text: 'review needed' });
    expect(rReview.memory.status).toBe('proposed');
  });

  it('guarantees always-on prompt remains byte-stable across checkpoints (cache stability)', () => {
    const root = mk({ git: true });
    initProject(root);

    const reportBefore = costReport(root);
    expect(reportBefore.alwaysOnTotal).toBeLessThanOrEqual(120);

    // Record multiple checkpoints simulating ongoing AI chat sessions
    checkpoint(root, 'First session task completed', { nextSteps: 'Next steps' });
    checkpoint(root, 'Second session bugfix', { nextSteps: 'Final test' });

    const reportAfter = costReport(root);
    // Always-on size and content must be identical
    expect(reportAfter.alwaysOnTotal).toBe(reportBefore.alwaysOnTotal);
    expect(reportAfter.alwaysOn).toEqual(reportBefore.alwaysOn);
  });

  it('where query returns compact file:line rows instead of whole file tree', () => {
    const root = mk();
    initProject(root);

    // Create a mock source file
    fs.writeFileSync(
      path.join(root, 'service.ts'),
      'export class AuthService {\n  login() {}\n  logout() {}\n}\n'
    );

    const hits = whereIs(root, 'AuthService');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.file).toBe('service.ts');
    expect(hits[0]!.line).toBe(1);

    // Also resolves non-code files (configs, package.json, etc.)
    fs.writeFileSync(path.join(root, 'package.json'), '{"name": "test"}');
    const fileHits = whereIs(root, 'package.json');
    expect(fileHits.length).toBeGreaterThan(0);
    expect(fileHits[0]!.file).toBe('package.json');
    expect(fileHits[0]!.kind).toBe('file');
  });
});
