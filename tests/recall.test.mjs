import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  agentRemember,
  approve,
  buildSanitizedInjectionContext,
  closeSharedSqliteStore,
  context,
  costReport,
  getProposals,
  initProject,
  passport,
  processLifecycleHookInput,
  propose,
  recordCheckpoint,
  runDoctor,
  syncWorkspace,
  whereIs,
} from '../dist/index.js';
import { HOOK_COMMAND, HOOK_NAME, resolveRecallCliPath } from '../dist/core/agent.js';

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

    // Verify durable decision was extracted safely as `proposed` (never silently promoted to active/PASSPORT.md!)
    const activeBeforeApproval = context(dir, 'Cache symbol landmarks mtime');
    assert.equal(activeBeforeApproval.length, 0, 'Passively extracted chat insights must NOT auto-promote to active memory');
    const passportBeforeApproval = fs.readFileSync(path.join(dir, '.recall', 'PASSPORT.md'), 'utf8');
    assert.doesNotMatch(passportBeforeApproval, /Cache symbol landmarks/);

    const proposals = getProposals(dir);
    assert.ok(proposals.some((m) => /Cache symbol landmarks/i.test(m.title)), 'Expected extracted decision in pending proposals');
    const decProp = proposals.find((m) => /Cache symbol landmarks/i.test(m.title));
    approve(dir, decProp.id);

    const memHitsAfterApproval = context(dir, 'Cache symbol landmarks mtime');
    assert.ok(memHitsAfterApproval.length > 0);
    const passportMd = fs.readFileSync(path.join(dir, '.recall', 'PASSPORT.md'), 'utf8');
    assert.match(passportMd, /Cache symbol landmarks/);

    // Non-destructive CURRENT_STATE.md: follow-up Q&A turn referencing NO files must preserve previous activeFileMap!
    const stateBeforeIdle = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    processLifecycleHookInput(
      JSON.stringify({
        conversationId: 'conv-123',
        workspacePaths: [dir],
        hookEventName: 'Stop',
        lastUserInput: 'Thanks, that makes sense!',
        response: 'Glad I could help!',
      }),
      dir,
    );
    const stateAfterIdle = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    assert.equal(stateAfterIdle, stateBeforeIdle, 'Idle Q&A turn must NOT destructively overwrite CURRENT_STATE.md');

    // Claude Code hook format returns `{}` and stages extracted conventions as `proposed`
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

    const convProposedHits = context(dir, 'validate frontmatter Zod schemas', { includeProposed: true });
    assert.ok(convProposedHits.length > 0);
    assert.equal(convProposedHits[0].memory.status, 'proposed');

    // Deleted files are evicted lazily on warm whereIs() even without forcing a full sync
    assert.ok(whereIs(dir, 'runEngine').length > 0);
    fs.rmSync(path.join(dir, 'src', 'engine.ts'));
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

test('Native Antigravity Session Integration: SessionStart/Stop hooks, protocol formats, .agents/ CWD execution, missing binary fallback, and fresh-session delivery', () => {
  makeTempProject((dir) => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'agy-native-app',
        description: 'Zero-command Antigravity session integration test project.',
        type: 'module',
        scripts: { build: 'tsc', test: 'node --test' },
      }),
    );
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'router.ts'),
      'export function routeRequest(pathStr: string): string {\n  return pathStr.trim();\n}\n',
    );

    // Initialize project WITHOUT --all-agents (default `recall init` path)
    initProject(dir);

    // Requirement 1: Verify .agents/hooks.json registers BOTH SessionStart and Stop
    const hooksJsonPath = path.join(dir, '.agents', 'hooks.json');
    assert.equal(fs.existsSync(hooksJsonPath), true);
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const recallHook = hooksConfig[HOOK_NAME];
    assert.ok(recallHook, `Expected ${HOOK_NAME} in .agents/hooks.json`);
    assert.ok(Array.isArray(recallHook.SessionStart) && recallHook.SessionStart.length === 1);
    assert.ok(Array.isArray(recallHook.Stop) && recallHook.Stop.length === 1);
    assert.equal(recallHook.SessionStart[0].command, HOOK_COMMAND);
    assert.equal(recallHook.Stop[0].command, HOOK_COMMAND);

    // Verify costReport produces 0 warnings with the updated hook configuration
    const cost = costReport(dir);
    assert.deepEqual(cost.warnings, []);

    // Seed an active memory and a proposed memory
    agentRemember(dir, {
      title: 'Strict idempotency key header on mutations',
      type: 'convention',
      tags: ['api', 'idempotency', 'headers'],
      text: 'Require X-Idempotency-Key on all POST and PATCH endpoints in src/router.ts.',
    });
    propose(dir, {
      title: 'Draft unapproved rate limit change',
      type: 'decision',
      tags: ['api'],
      text: 'DRAFT_PROPOSED_DO_NOT_INJECT',
    });

    // TEST 1: Antigravity SessionStart camelCase payload -> injectSteps/systemMessage format
    const agyStartOut = processLifecycleHookInput(
      JSON.stringify({
        conversationId: 'agy-conv-101',
        workspacePaths: [dir],
        hookEventName: 'SessionStart',
        modelName: 'auto',
        cwd: dir,
      }),
      dir,
    );
    const agyStartJson = JSON.parse(agyStartOut);
    assert.ok(Array.isArray(agyStartJson.injectSteps), 'Expected Antigravity injectSteps array');
    assert.equal(agyStartJson.injectSteps.length, 1);
    const agySysMsg = agyStartJson.injectSteps[0]?.systemMessage?.systemMessage ?? '';
    assert.match(agySysMsg, /agy-native-app/);
    assert.match(agySysMsg, /Strict idempotency key header on mutations/);
    assert.doesNotMatch(agySysMsg, /DRAFT_PROPOSED_DO_NOT_INJECT/);
    assert.equal(agyStartJson.hookSpecificOutput, undefined);

    // TEST 2: Claude Code SessionStart snake_case payload -> hookSpecificOutput format preserved
    const claudeStartOut = processLifecycleHookInput(
      JSON.stringify({
        session_id: 'claude-sess-202',
        cwd: dir,
        hook_event_name: 'SessionStart',
      }),
      dir,
    );
    const claudeStartJson = JSON.parse(claudeStartOut);
    assert.equal(claudeStartJson?.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(claudeStartJson?.hookSpecificOutput?.additionalContext ?? '', /Strict idempotency key header on mutations/);
    assert.doesNotMatch(claudeStartJson?.hookSpecificOutput?.additionalContext ?? '', /DRAFT_PROPOSED_DO_NOT_INJECT/);
    assert.equal(claudeStartJson.injectSteps, undefined);

    // TEST 3: Antigravity Stop event (both with hookEventName: 'Stop' and with terminationReason)
    const agyStopOut = processLifecycleHookInput(
      JSON.stringify({
        conversationId: 'agy-conv-101',
        workspacePaths: [dir],
        hookEventName: 'Stop',
        lastUserInput: 'We updated src/router.ts request routing.',
        response: 'Completed routing update in src/router.ts.',
        modelName: 'Gemini 2.5 Pro',
      }),
      dir,
    );
    assert.deepEqual(JSON.parse(agyStopOut), { decision: 'stop' });
    const currentStateAfterStop = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    assert.match(currentStateAfterStop, /Gemini 2\.5 Pro/);
    assert.match(currentStateAfterStop, /`src\/router\.ts`/);
    assert.match(currentStateAfterStop, /`routeRequest` \(:1\)/);

    // TEST 7: Fresh-session context delivery WITHOUT running manual Recall CLI commands
    // Simulate a user hand-editing .recall/MEMORY.md and .recall/rules/architecture.md directly on disk
    fs.writeFileSync(
      path.join(dir, '.recall', 'MEMORY.md'),
      '# Project Memory\n\n## Critical constraints\n- Never block the event loop with synchronous crypto in request handlers.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '.recall', 'rules', 'architecture.md'),
      '# Architecture rules\n\n- Keep all route handlers pure and stateless inside `src/router.ts`.\n',
      'utf8',
    );

    const freshSessionOut = processLifecycleHookInput(
      JSON.stringify({
        conversationId: 'agy-conv-fresh-102',
        workspacePaths: [dir],
        hookEventName: 'SessionStart',
        lastUserInput: 'Check idempotency headers in router',
      }),
      dir,
    );
    const freshSessionMsg = JSON.parse(freshSessionOut)?.injectSteps?.[0]?.systemMessage?.systemMessage ?? '';
    assert.match(
      freshSessionMsg,
      /Never block the event loop with synchronous crypto/,
      'Expected hand-edited MEMORY.md rule to be delivered automatically in fresh session without manual CLI rebuild',
    );
    assert.match(
      freshSessionMsg,
      /Keep all route handlers pure and stateless/,
      'Expected hand-edited rules/architecture.md rule to be delivered automatically in fresh session',
    );
    assert.match(
      freshSessionMsg,
      /## Active Working Files & Symbol Map \(Skip File Discovery\)/,
      'Expected active file symbol map from previous turn to be delivered in fresh session',
    );
    assert.match(
      freshSessionMsg,
      /## Relevant Active Memory/,
      'Expected relevant memories matching lastUserInput on SessionStart',
    );

    // TEST 5: Hook execution as a real shell subprocess from `.agents/` working directory
    const agentsCwd = path.join(dir, '.agents');
    const resolvedCli = resolveRecallCliPath(agentsCwd, { allowGlobalPath: false });
    assert.ok(resolvedCli && fs.existsSync(resolvedCli), `Expected resolveRecallCliPath from .agents/ to find CLI, got ${resolvedCli}`);

    const sessionStartCmd = recallHook.SessionStart[0].command;
    const subprocStart = spawnSync(sessionStartCmd, {
      cwd: agentsCwd,
      shell: true,
      input: JSON.stringify({
        conversationId: 'agy-subproc-1',
        hookEventName: 'SessionStart',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(subprocStart.status, 0, `Expected hook command from .agents/ to exit 0, stderr: ${subprocStart.stderr}`);
    const subprocStartJson = JSON.parse(subprocStart.stdout.trim());
    assert.ok(Array.isArray(subprocStartJson.injectSteps), 'Expected subprocess SessionStart from .agents/ to output injectSteps');
    assert.match(subprocStartJson.injectSteps[0].systemMessage.systemMessage, /agy-native-app/);
    assert.match(subprocStartJson.injectSteps[0].systemMessage.systemMessage, /Strict idempotency key header on mutations/);

    const subprocStop = spawnSync(recallHook.Stop[0].command, {
      cwd: agentsCwd,
      shell: true,
      input: JSON.stringify({
        conversationId: 'agy-subproc-1',
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(subprocStop.status, 0);
    assert.deepEqual(JSON.parse(subprocStop.stdout.trim()), { decision: 'stop' });

    // TEST 4: Missing Recall executable (graceful no-crash fallback from .agents/ CWD)
    const missingResolved = resolveRecallCliPath(agentsCwd, {
      cliPathOverride: path.join(dir, 'nonexistent-recall-cli.js'),
      allowGlobalPath: false,
    });
    assert.equal(missingResolved, null);

    const subprocMissing = spawnSync(sessionStartCmd, {
      cwd: agentsCwd,
      shell: true,
      env: {
        ...process.env,
        RECALL_CLI_PATH: path.join(dir, 'nonexistent-recall-cli.js'),
      },
      input: JSON.stringify({
        conversationId: 'agy-missing-bin',
        hookEventName: 'SessionStart',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(subprocMissing.status, 0, 'Missing executable must exit 0 so the agent loop never crashes');
    assert.deepEqual(JSON.parse(subprocMissing.stdout.trim()), {});

    // TEST 6: Empty or malformed input (never throws, returns '{}', never corrupts CURRENT_STATE.md)
    const stateBeforeMalformed = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    const malformedInputs = [
      '',
      '   \n\t  ',
      '{ malformed json',
      '{"hookEventName": "SessionStart", broken}',
      'plain random text not json',
      'null',
      '[]',
      '12345',
      '{}',
      JSON.stringify({ workspacePaths: 12345, hookEventName: null, cwd: false }),
    ];
    for (const badInput of malformedInputs) {
      const out = processLifecycleHookInput(badInput, dir);
      assert.equal(out, '{}', `Expected '{}' for malformed/empty input ${JSON.stringify(badInput)}, got ${out}`);
    }
    const stateAfterMalformed = fs.readFileSync(path.join(dir, '.recall', 'CURRENT_STATE.md'), 'utf8');
    assert.equal(
      stateAfterMalformed,
      stateBeforeMalformed,
      'Empty or malformed hook input must never overwrite or corrupt CURRENT_STATE.md',
    );
  });
});

test('Stage 3: Incremental symbol extraction (class methods, typed arrows, consts, multi-word), gitignore hygiene, and expired keyword filtering', () => {
  makeTempProject((dir) => {
    fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'auth', 'token-service.ts'),
      [
        'export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;',
        'export const appendImmutableEntry = async (id: string): Promise<boolean> => Boolean(id);',
        'export class AuthTokenService {',
        '  revokeSessionSync(sessionId: string): boolean {',
        '    return sessionId.length > 0;',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    initProject(dir);

    // 1. Verify .recall/.gitignore ignores CURRENT_STATE.md and sessions/ by default
    const gitignore = fs.readFileSync(path.join(dir, '.recall', '.gitignore'), 'utf8');
    assert.match(gitignore, /^CURRENT_STATE\.md$/m);
    assert.match(gitignore, /^sessions\/$/m);

    // 2. Verify previously missed symbol types and multi-word queries resolve on warm cache
    assert.equal(whereIs(dir, 'revokeSessionSync')[0]?.line, 4);
    assert.equal(whereIs(dir, 'DEFAULT_CLOCK_TOLERANCE_SEC')[0]?.line, 1);
    assert.equal(whereIs(dir, 'appendImmutableEntry')[0]?.line, 2);
    assert.equal(whereIs(dir, 'token service')[0]?.name, 'AuthTokenService');

    // 3. Verify lazy line refresh when 1 file is edited (no full sync required)
    fs.writeFileSync(
      path.join(dir, 'src', 'auth', 'token-service.ts'),
      [
        '// Added header comment line 1',
        '// Added header comment line 2',
        'export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;',
        'export const appendImmutableEntry = async (id: string): Promise<boolean> => Boolean(id);',
        'export class AuthTokenService {',
        '  revokeSessionSync(sessionId: string): boolean {',
        '    return sessionId.length > 0;',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );
    assert.equal(whereIs(dir, 'revokeSessionSync')[0]?.line, 6);

    // 4. Verify keyword-only search (`hybrid: false`) filters out expired memories (0% leak)
    agentRemember(dir, {
      title: 'Expired holiday rate limit freeze',
      type: 'decision',
      tags: ['ratelimit'],
      expiresAt: '2020-01-01',
      text: 'Temporary expired rate limit rule that must never be returned by keyword search.',
    });
    const kwHits = context(dir, 'holiday rate limit freeze', { hybrid: false });
    assert.equal(kwHits.length, 0, 'Expired memories must be excluded from keyword-only search');
  });
});

test('Stage 3 Verification (Check B): Cache correctness across uncommitted edits, reverts, untracked files, renames/deletes, branch switches, .gitignore edits, cache deletion, and preserved mtime', () => {
  makeTempProject((dir) => {
    const runGit = (args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
      });

    runGit(['init']);
    runGit(['config', 'user.email', 'test@recall.local']);
    runGit(['config', 'user.name', 'Recall Test']);

    fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'src', 'core', 'alpha.ts'),
      'export function alphaOrigin(): number {\n  return 1;\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'generated', 'gen-client.ts'),
      'export function generatedClientApi(): string {\n  return "ok";\n}\n',
      'utf8',
    );

    initProject(dir);
    agentRemember(dir, {
      title: 'Cache durability anchor memory',
      type: 'decision',
      tags: ['cache', 'durability'],
      text: 'Durable memory must survive cache deletion and rebuild seamlessly.',
    });

    runGit(['add', '.']);
    runGit(['commit', '-m', 'Initial commit']);
    syncWorkspace(dir);

    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.line, 1);
    assert.equal(whereIs(dir, 'generatedClientApi')[0]?.file, 'src/generated/gen-client.ts');

    // 1. File content changes without a Git commit + revert via git checkout
    const alphaPath = path.join(dir, 'src', 'core', 'alpha.ts');
    fs.writeFileSync(
      alphaPath,
      '// uncommitted line 1\n// uncommitted line 2\nexport function alphaOrigin(): number {\n  return 2;\n}\nexport function alphaUncommitted(): boolean {\n  return true;\n}\n',
      'utf8',
    );
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.line, 3);
    assert.equal(whereIs(dir, 'alphaUncommitted')[0]?.line, 6);

    // Revert back to HEAD without commit -> git status becomes clean while HEAD is unchanged
    runGit(['checkout', '--', 'src/core/alpha.ts']);
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.line, 1, 'Reverted file must restore line 1 in cache');
    assert.equal(whereIs(dir, 'alphaUncommitted').length, 0, 'Symbol from reverted file must be evicted');

    // 2. Untracked files
    const untrackedPath = path.join(dir, 'src', 'core', 'untracked-new.ts');
    fs.writeFileSync(untrackedPath, 'export function untrackedSymbolFn(): void {}\n', 'utf8');
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'untrackedSymbolFn')[0]?.file, 'src/core/untracked-new.ts');
    fs.rmSync(untrackedPath);
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'untrackedSymbolFn').length, 0, 'Deleted untracked file must be evicted');

    // 3. Staged rename (`git mv`) and file deletion
    runGit(['mv', 'src/core/alpha.ts', 'src/core/alpha-renamed.ts']);
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.file, 'src/core/alpha-renamed.ts');
    assert.equal(whereIs(dir, 'alpha.ts').length, 0, 'Old renamed filename must be evicted from cache');
    // Restore back to alpha.ts for subsequent checks
    runGit(['mv', 'src/core/alpha-renamed.ts', 'src/core/alpha.ts']);
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.file, 'src/core/alpha.ts');

    // 4. Branch switches
    const mainBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    runGit(['checkout', '-b', 'feature/branch-check']);
    fs.writeFileSync(
      path.join(dir, 'src', 'core', 'branch-only.ts'),
      'export function featureBranchOnlyFn(): string { return "branch"; }\n',
      'utf8',
    );
    runGit(['add', 'src/core/branch-only.ts']);
    runGit(['commit', '-m', 'Add feature branch file']);
    syncWorkspace(dir);
    assert.equal(whereIs(dir, 'featureBranchOnlyFn')[0]?.file, 'src/core/branch-only.ts');

    runGit(['checkout', mainBranch]);
    syncWorkspace(dir);
    assert.equal(
      whereIs(dir, 'featureBranchOnlyFn').length,
      0,
      'Switching back to main branch must evict symbols that only exist on feature branch',
    );

    // 5. Changes to `.gitignore` (newly ignore `src/generated/`, then un-ignore it)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\nsrc/generated/\n', 'utf8');
    syncWorkspace(dir);
    assert.equal(
      whereIs(dir, 'generatedClientApi').length,
      0,
      'Adding src/generated/ to .gitignore must evict its symbols from cache',
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    assert.equal(
      whereIs(dir, 'generatedClientApi')[0]?.file,
      'src/generated/gen-client.ts',
      'Removing src/generated/ from .gitignore must re-index its symbols automatically on whereIs()',
    );

    // 6. Cache deletion (`.recall/.cache`) and full automatic reconstruction
    closeSharedSqliteStore(path.join(dir, '.recall'));
    fs.rmSync(path.join(dir, '.recall', '.cache'), { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(dir, '.recall', '.cache')), false);
    assert.equal(whereIs(dir, 'alphaOrigin')[0]?.file, 'src/core/alpha.ts');
    assert.ok(context(dir, 'Cache durability anchor memory').length > 0);
    assert.equal(fs.existsSync(path.join(dir, '.recall', '.cache', 'landmarks-cache.json')), true);
    let hasNodeSqlite = false;
    try {
      createRequire(import.meta.url)('node:sqlite');
      hasNodeSqlite = true;
    } catch {
      hasNodeSqlite = false;
    }
    assert.equal(fs.existsSync(path.join(dir, '.recall', '.cache', 'recall.db')), hasNodeSqlite);

    // 7. File whose timestamp (`mtimeMs`) is preserved via `utimesSync` while contents change (IDENTICAL byte size!)
    const preservedPath = path.join(dir, 'src', 'core', 'alpha.ts');
    const origContent = 'export function alphaOrigin(): number {\n  return 1;\n}\n';
    const sameLenNew = 'export function omegaMutate(): number {\n  return 9;\n}\n';
    assert.equal(Buffer.byteLength(origContent, 'utf8'), Buffer.byteLength(sameLenNew, 'utf8'));
    const statBefore = fs.statSync(preservedPath);

    // Wait briefly so kernel ctimeMs advances past original timestamp, then write same-length content & restore mtime
    const waitUntil = Date.now() + 30;
    while (Date.now() < waitUntil) {
      // spin 30ms synchronously to cross OS timer tick
    }
    fs.writeFileSync(preservedPath, sameLenNew, 'utf8');
    fs.utimesSync(preservedPath, statBefore.atime, statBefore.mtime);

    // Warm whereIs() must detect the preserved-mtime content change via ctimeMs!
    assert.equal(
      whereIs(dir, 'alphaOrigin').length,
      0,
      'Old symbol must disappear when file content changes with preserved mtime and identical size',
    );
    assert.equal(
      whereIs(dir, 'omegaMutate')[0]?.line,
      1,
      'New symbol must be found even when file mtime and byte size were preserved',
    );
  });
});





