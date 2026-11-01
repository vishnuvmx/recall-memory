import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  agentRemember,
  closeSharedSqliteStore,
  context,
  costReport,
  initProject,
  passport,
  processLifecycleHookInput,
  syncWorkspace,
  whereIs,
} from '../dist/index.js';

function makeTempProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
  try {
    return fn(dir);
  } finally {
    closeSharedSqliteStore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PASSPORT.md captures non-volatile identity/modules and skips cold re-analysis when unchanged', () => {
  makeTempProject((dir) => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo-engine',
        description: 'Local deterministic invoice parser.',
        type: 'module',
        engines: { node: '>=20' },
        dependencies: { zod: '^3.23.8' },
        scripts: { build: 'tsc', test: 'node --test' },
      }),
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'parser.ts'),
      'export class InvoiceParser {\n  parse(raw: string): boolean {\n    function innerHelper() { return true; }\n    return innerHelper() && raw.length > 0;\n  }\n}\n',
    );

    initProject(dir, { allAgents: true });

    const passFile = path.join(dir, '.recall', 'PASSPORT.md');
    assert.equal(fs.existsSync(passFile), true);
    const content = fs.readFileSync(passFile, 'utf8');
    assert.match(content, /demo-engine/);
    assert.match(content, /Local deterministic invoice parser/);
    assert.match(content, /InvoiceParser/);
    // Inner nested helper functions must NOT pollute exported API surface
    assert.doesNotMatch(content, /innerHelper/);

    // Multi-model bridges & hooks installed
    assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), true);
    assert.equal(fs.existsSync(path.join(dir, 'CLAUDE.md')), true);
    assert.equal(fs.existsSync(path.join(dir, '.agents', 'hooks.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.local.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.cursor', 'hooks.json')), true);

    // Always-on token cost stays strictly under 120 tokens
    const cost = costReport(dir);
    assert.ok(cost.alwaysOnTotal <= 120, `Expected <= 120 always-on tokens, got ${cost.alwaysOnTotal}`);

    // Second run performs 0 cold re-analysis (updated: false)
    const second = passport(dir);
    assert.equal(second.updated, false);

    // Changing implementation body without changing exports keeps PASSPORT.md non-volatile!
    fs.writeFileSync(
      path.join(dir, 'src', 'parser.ts'),
      'export class InvoiceParser {\n  // added comment\n  parse(raw: string): boolean {\n    return raw.trim().length > 1;\n  }\n}\n',
    );
    const afterImplEdit = passport(dir);
    assert.equal(afterImplEdit.updated, false);
  });
});

test('MEMORY.md, rules/*.md, and long file paths are indexed and searchable without false secret errors', () => {
  makeTempProject((dir) => {
    initProject(dir);

    // Write custom non-volatile constraints in MEMORY.md and rules/architecture.md
    fs.writeFileSync(
      path.join(dir, '.recall', 'MEMORY.md'),
      '# Project Memory\n\n## Critical constraints\n- Never mutate invoice ledger rows in place; append immutable adjustments.\n',
    );
    fs.writeFileSync(
      path.join(dir, '.recall', 'rules', 'architecture.md'),
      '# Architecture rules\n\n- Keep PDF rendering isolated inside `src/components/DocumentViewer/PdfCanvasController.tsx`.\n',
    );

    // Saving a memory containing a high-entropy-looking camelCase file path must succeed
    const saved = agentRemember(dir, {
      title: 'Session controller boundary',
      text: 'Route auth state through src/components/AuthenticationProvider/SessionController.tsx instead of global singletons.',
      type: 'decision',
      tags: ['auth'],
    });
    assert.equal(saved.action, 'created');

    // Actual secrets must still be rejected
    assert.throws(() => {
      agentRemember(dir, {
        title: 'Bad key',
        text: 'Use sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd for tests',
        type: 'fact',
      });
    }, /secret/i);

    const hitsLedger = context(dir, 'immutable invoice ledger adjustments');
    assert.ok(hitsLedger.some((h) => h.memory.file === 'MEMORY.md'));

    const hitsPdf = context(dir, 'PdfCanvasController isolated rendering');
    assert.ok(hitsPdf.some((h) => h.memory.file === 'rules/architecture.md'));
  });
});

test('Normal chat lifecycle hooks (Antigravity & Claude Code) update CURRENT_STATE and extract durable decisions without git changes', () => {
  makeTempProject((dir) => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'engine.ts'), 'export function runEngine() { return 42; }\n');
    initProject(dir);

    // Simulate an Antigravity transcript.jsonl for a normal Q&A + architecture chat (clean working tree)
    const transcriptFile = path.join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>How should we handle caching in src/engine.ts?</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'Use MTime + SHA-256 content fingerprints in `.recall/.cache`.\n\nDecision: Cache symbol landmarks by file mtime and size so unchanged files skip re-parsing completely.',
      }),
    ];
    fs.writeFileSync(transcriptFile, `${lines.join('\n')}\n`);

    const agyOut = processLifecycleHookInput(
      JSON.stringify({
        conversationId: 'conv-123',
        workspacePaths: [dir],
        transcriptPath: transcriptFile,
        modelName: 'Gemini 4',
        terminationReason: 'NO_TOOL_CALL',
      }),
      dir,
    );
    assert.deepEqual(JSON.parse(agyOut), { decision: 'stop' });

    const stateMd = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    assert.match(stateMd, /Gemini 4/);
    assert.match(stateMd, /How should we handle caching/);
    assert.match(stateMd, /src\/engine\.ts/);

    // Verify durable decision was automatically extracted into .recall/decisions/ and PASSPORT.md!
    const memHits = context(dir, 'Cache symbol landmarks mtime');
    assert.ok(memHits.length > 0);
    const passportMd = fs.readFileSync(path.join(dir, '.recall', 'PASSPORT.md'), 'utf8');
    assert.match(passportMd, /Cache symbol landmarks/);

    // Claude Code hook format returns `{}`
    const claudeOut = processLifecycleHookInput(
      JSON.stringify({
        session_id: 'claude-456',
        cwd: dir,
        hook_event_name: 'Stop',
        prompt: 'Convention: Always validate frontmatter with Zod schemas before indexing.',
      }),
      dir,
    );
    assert.equal(claudeOut, '{}');

    const convHits = context(dir, 'validate frontmatter Zod schemas');
    assert.ok(convHits.length > 0);

    // Deleted files are evicted from landmarks cache
    assert.ok(whereIs(dir, 'runEngine').length > 0);
    fs.rmSync(path.join(dir, 'src', 'engine.ts'));
    syncWorkspace(dir, { force: true });
    assert.equal(whereIs(dir, 'runEngine').length, 0);
  });
});

