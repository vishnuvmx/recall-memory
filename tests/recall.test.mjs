import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  agentRemember,
  buildSanitizedInjectionContext,
  closeSharedSqliteStore,
  context,
  costReport,
  initProject,
  passport,
  processLifecycleHookInput,
  propose,
  recordCheckpoint,
  runDoctor,
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

test('v0.4.0: Sanitized SessionStart injection, corpus co-occurrence expansion, and non-blocking dedup/conflict warnings', () => {
  makeTempProject((dir) => {
    initProject(dir, { allAgents: true });

    // 1. Verify Claude Code settings.local.json registers both SessionStart and Stop hooks
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(Array.isArray(claudeSettings.hooks?.SessionStart), 'Expected SessionStart hook in Claude settings');
    assert.ok(Array.isArray(claudeSettings.hooks?.Stop), 'Expected Stop hook in Claude settings');

    // 2. Seed sibling memories to test corpus co-occurrence query expansion + non-blocking warnings
    const memJwt = agentRemember(dir, {
      title: 'JWT 401 bug on container clock skew',
      type: 'bugfix',
      tags: ['auth', 'jwt', 'token', 'clock'],
      text: 'Bearer tokens rejected with HTTP 401 when container NTP drifted by >30s. Added 60s clockTolerance.',
    });
    assert.equal(memJwt.action, 'created');

    const memOauth = agentRemember(dir, {
      title: 'Session cookie SameSite=Lax requirement for OAuth callback',
      type: 'decision',
      tags: ['auth', 'oauth', 'cookie', 'login', 'signin', 'jwt'],
      text: 'Use SameSite=Lax on the session cookie so external OAuth login and signin redirects preserve session state.',
    });
    assert.equal(memOauth.action, 'created');

    // Proposed memory MUST NEVER be injected at SessionStart or ranked by default
    propose(dir, {
      title: 'Unverified proposal for auth token rotation',
      type: 'decision',
      tags: ['auth', 'login', 'jwt'],
      text: 'UNVERIFIED_PROPOSED_MARKER: rotate tokens every 30 seconds.',
    });

    // 3. Test corpus-derived co-occurrence + stem retrieval ("signin fails when server clock is off" -> memJwt #1, "login failure" -> memJwt in top 2)
    const signinHits = context(dir, 'signin fails when server clock is off');
    assert.equal(signinHits[0]?.memory.id, memJwt.memory.id);

    const loginFailureHits = context(dir, 'login failure');
    assert.ok(
      loginFailureHits.slice(0, 2).some((h) => h.memory.id === memJwt.memory.id),
      'Expected "login failure" to retrieve JWT 401 bugfix in top 2 via corpus tag co-occurrence',
    );
    assert.ok(
      !loginFailureHits.some((h) => h.memory.body.includes('UNVERIFIED_PROPOSED_MARKER')),
      'Proposed memories must never appear in default context hits',
    );

    // 4. Test Claude Code SessionStart & UserPromptSubmit injection hook (sanitized, deterministic, no file writes)
    const passportPath = path.join(dir, '.recall', 'PASSPORT.md');
    const mtimeBefore = fs.statSync(passportPath).mtimeMs;

    const sessionStartRaw = processLifecycleHookInput(
      JSON.stringify({
        session_id: 'claude-sess-1',
        cwd: dir,
        hook_event_name: 'SessionStart',
      }),
      dir,
    );
    const sessionStartParsed = JSON.parse(sessionStartRaw);
    const injected = sessionStartParsed?.hookSpecificOutput?.additionalContext ?? '';
    assert.equal(sessionStartParsed?.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(injected, /JWT 401 bug on container clock skew/);
    assert.doesNotMatch(injected, /UNVERIFIED_PROPOSED_MARKER/);
    assert.doesNotMatch(injected, /Unverified proposal for auth token rotation/);

    // Verify deterministic cached output & zero PASSPORT.md mutation
    const mtimeAfter = fs.statSync(passportPath).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore);
    const secondInjected = buildSanitizedInjectionContext(dir);
    assert.equal(secondInjected, injected);

    // 5. Test non-blocking near-duplicate and conflict warnings (warn, never auto-merge or auto-supersede)
    const memRest = agentRemember(dir, {
      title: 'Use REST endpoints for public client API',
      type: 'decision',
      tags: ['api', 'rest', 'endpoints'],
      text: 'All public client API endpoints use REST JSON over HTTP.',
    });
    assert.equal(memRest.action, 'created');

    // Near-duplicate with different title words: should create AND warn, not overwrite memRest
    const nearDup = agentRemember(dir, {
      title: 'Public client API endpoint convention',
      type: 'decision',
      tags: ['api', 'rest', 'endpoints'],
      text: 'Expose public client API endpoints using standard REST JSON conventions.',
    });
    assert.equal(nearDup.action, 'created');
    assert.notEqual(nearDup.memory.id, memRest.memory.id);
    assert.ok(
      nearDup.warnings?.some((w) => w.includes('Possible duplicate') && w.includes(memRest.memory.id)),
      `Expected near-duplicate warning referencing ${memRest.memory.id}, got: ${JSON.stringify(nearDup.warnings)}`,
    );

    // Contradiction / replacement on shared topic: should create AND warn ("Possible conflict"), keeping memRest active!
    const conflicting = agentRemember(dir, {
      title: 'Migrate public client API to GraphQL instead of REST',
      type: 'decision',
      tags: ['api', 'rest', 'graphql', 'endpoints'],
      text: 'Switch public client API endpoints to GraphQL instead of REST to avoid over-fetching.',
    });
    assert.equal(conflicting.action, 'created');
    assert.ok(
      conflicting.warnings?.some((w) => w.includes('Possible conflict') && w.includes(memRest.memory.id)),
      `Expected conflict warning referencing ${memRest.memory.id}, got: ${JSON.stringify(conflicting.warnings)}`,
    );

    // Confirm memRest was NOT silently superseded
    const activeRestHits = context(dir, 'REST endpoints public client API');
    assert.ok(activeRestHits.some((h) => h.memory.id === memRest.memory.id && h.memory.status === 'active'));

    // 6. Test auto-tag inference when saving an untagged memory
    const untaggedMem = agentRemember(dir, {
      title: 'Handle JWT refresh token expiry in REST middleware',
      type: 'bugfix',
      text: 'Refresh JWT tokens before calling REST endpoints when clock skew is detected.',
    });
    assert.ok(
      untaggedMem.memory.tags.length >= 2,
      `Expected untagged memory to auto-infer tags from corpus/title, got: ${JSON.stringify(untaggedMem.memory.tags)}`,
    );
    assert.ok(
      untaggedMem.memory.tags.includes('jwt') || untaggedMem.memory.tags.includes('rest') || untaggedMem.memory.tags.includes('auth'),
      `Expected inferred tags to include corpus tags, got: ${JSON.stringify(untaggedMem.memory.tags)}`,
    );

    // 7. Test Active Working Files & Symbol Map in CURRENT_STATE.md and SessionStart injection
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'auth-handler.ts'),
      [
        'export interface AuthSession {',
        '  userId: string;',
        '}',
        '',
        'export function verifyJwtToken(token: string): boolean {',
        '  return token.length > 10;',
        '}',
        '',
        'export async function refreshAuthSession(session: AuthSession): Promise<void> {',
        '  void session;',
        '}',
      ].join('\n'),
      'utf8',
    );
    const cp = recordCheckpoint(
      dir,
      path.join(dir, '.recall'),
      'Implemented verifyJwtToken and refreshAuthSession in src/auth-handler.ts.',
      { referencedFiles: ['src/auth-handler.ts'] },
    );
    assert.ok(cp.activeFileMap && cp.activeFileMap.length > 0, 'Expected activeFileMap to be populated for src/auth-handler.ts');
    assert.match(cp.activeFileMap[0], /`src\/auth-handler\.ts` \(11 lines\)/);
    assert.match(cp.activeFileMap[0], /`verifyJwtToken` \(:5\)/);
    assert.match(cp.activeFileMap[0], /`refreshAuthSession` \(:9\)/);

    const injectedWithMap = buildSanitizedInjectionContext(dir);
    assert.match(injectedWithMap, /## Active Working Files & Symbol Map \(Skip File Discovery\)/);
    assert.match(injectedWithMap, /`verifyJwtToken` \(:5\)/);

    // 8. Test runDoctor detection of stale file references when a referenced repo file is deleted
    agentRemember(dir, {
      title: 'Legacy token validator location',
      type: 'fact',
      tags: ['auth'],
      text: 'Legacy validation logic lived in `src/deleted-validator.ts` before refactor.',
    });
    const doctorChecks = runDoctor(dir);
    const fileRefCheck = doctorChecks.find((c) => c.name === 'memory file references');
    assert.ok(fileRefCheck, 'Expected runDoctor to include memory file references check');
    assert.equal(fileRefCheck.ok, false);
    assert.match(fileRefCheck.detail, /src\/deleted-validator\.ts/);
  });
});


