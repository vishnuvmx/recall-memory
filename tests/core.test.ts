import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { loadAll } from '../src/core/memory.js';
import { indexState, rebuildIndex, brokenIndexLinks } from '../src/core/index-builder.js';
import { approve, approveAll, archive, archiveAll, context, getProposals, log, propose, remember, status, undo } from '../src/core/service.js';
import { seed } from '../src/core/seed.js';
import { runDoctor } from '../src/core/doctor.js';
import { handleMessage } from '../src/mcp/server.js';
import { RecallError } from '../src/utils/fs.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const setup = (o?: { git?: boolean }): string => {
  const d = tmpProject(o);
  dirs.push(d);
  initProject(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('remember', () => {
  it('persists valid markdown with stable ids and unverified status', () => {
    const root = setup();
    const a = remember(root, { title: 'Use semantic design tokens', text: 'Always use tokens.', type: 'design_system', tags: ['ui'] });
    const b = remember(root, { title: 'Use semantic design tokens', text: 'Same title again.', type: 'design_system' });
    expect(a.id).toBe('mem_001');
    expect(b.id).toBe('mem_002');
    expect(a.file).not.toBe(b.file);
    expect(a.verification).toBe('unverified');
    const raw = fs.readFileSync(path.join(root, '.recall', a.file), 'utf8');
    expect(raw).toMatch(/^---\nid: mem_001/);
    const l = loadAll(path.join(root, '.recall'));
    expect(l.memories).toHaveLength(2);
    expect(l.problems).toEqual([]);
  });
  it('rejects empty input and secrets', () => {
    const root = setup();
    expect(() => remember(root, { title: ' ', text: 'x' })).toThrow(RecallError);
    expect(() => remember(root, { title: 'k', text: 'api_key = abcdef1234567890abcdef' })).toThrow(/secret/);
    expect(() => remember(root, { title: 'k', text: '-----BEGIN RSA PRIVATE KEY-----' })).toThrow(/secret/);
    expect(() => remember(root, { title: 'k', text: 'AIzaSyD-1234567890abcdef1234567890abcdef' })).toThrow(/Google API key/);
    expect(() => remember(root, { title: 'k', text: 'xoxb-1234567890-1234567890-abcdef' })).toThrow(/Slack token/);
    expect(() => remember(root, { title: 'k', text: 'sk_live_1234567890abcdef12345678' })).toThrow(/Stripe API key/);
    expect(() => remember(root, { title: 'k', text: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c9W3yP6F' })).toThrow(/JWT/);
    expect(() => remember(root, { title: 'k', text: 'postgres://admin:mysecretpassword@db.example.com:5432/mydb' })).toThrow(/connection string/);
  });
  it('forces proposed status when RECALL_AGENT is enabled', () => {
    const root = setup();
    process.env.RECALL_AGENT = '1';
    try {
      const m = remember(root, { title: 'Agent proposed fact', text: 'Agent learning' });
      expect(m.status).toBe('proposed');
    } finally {
      delete process.env.RECALL_AGENT;
    }
  });
  it('does not reuse ids of malformed files and handles unicode titles', () => {
    const root = setup();
    fs.writeFileSync(path.join(root, '.recall', 'lessons', 'mem_007-bad.md'), '---\nid: [oops\n---\n');
    const m = remember(root, { title: 'Ünïcödé 日本語 タイトル', text: 'body', type: 'lesson' });
    expect(m.id).toBe('mem_008');
    expect(m.file).toContain('日本語');
  });
  it('requires initialization', () => {
    const d = tmpProject();
    dirs.push(d);
    expect(() => remember(d, { title: 't', text: 'x' })).toThrow(/not initialized/);
  });
});

describe('context search', () => {
  it('ranks relevant memories, excludes archived/proposed, handles empty results', () => {
    const root = setup();
    remember(root, { title: 'PDF annotation scaling', text: 'Scale annotations by zoom factor.', type: 'lesson', tags: ['pdf'] });
    remember(root, { title: 'Database choice', text: 'We use SQLite for the pdf cache.', type: 'decision' });
    const old = remember(root, { title: 'Old PDF approach', text: 'pdf annotation legacy', type: 'failed_approach' });
    archive(root, old.id);
    propose(root, { title: 'Proposed pdf annotation idea', text: 'pdf annotation', type: 'fact' });

    const hits = context(root, 'Refactor PDF annotation scaling', {});
    expect(hits[0]!.memory.title).toBe('PDF annotation scaling');
    expect(hits.map((h) => h.memory.title)).not.toContain('Old PDF approach');
    expect(hits.map((h) => h.memory.status)).not.toContain('proposed');
    expect(context(root, 'kubernetes helm', {})).toEqual([]);
    expect(context(root, 'pdf', { limit: 1 })).toHaveLength(1);
    expect(context(root, 'pdf annotation', { includeProposed: true }).some((h) => h.memory.status === 'proposed')).toBe(true);
  });
  it('is deterministic', () => {
    const root = setup();
    for (let i = 0; i < 4; i++) remember(root, { title: `note ${i}`, text: 'shared keyword render' });
    const a = context(root, 'render', {}).map((h) => h.memory.id);
    expect(context(root, 'render', {}).map((h) => h.memory.id)).toEqual(a);
  });
  it('approves proposed memories and makes them searchable', () => {
    const root = setup();
    const prop = propose(root, { title: 'Proposed architecture rule', text: 'Important rule' });
    expect(context(root, 'architecture rule', {})).toHaveLength(0);
    const approved = approve(root, prop.id);
    expect(approved.status).toBe('active');
    const hits = context(root, 'architecture rule', {});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.id).toBe(prop.id);
  });
  it('respects word boundaries so substrings like rapid/api or dialog/log do not produce false hits', () => {
    const root = setup();
    remember(root, { title: 'Rapid development guide', text: 'Move quickly and build prototypes.', type: 'convention' });
    remember(root, { title: 'REST API service design', text: 'Always version backend endpoints.', type: 'decision' });
    remember(root, { title: 'Dialog modal animations', text: 'Smooth fade transitions for modal components.', type: 'design_system' });
    remember(root, { title: 'Audit log storage', text: 'Store event logs securely.', type: 'lesson' });

    // "api" must NOT match "Rapid"
    const apiHits = context(root, 'api', {});
    expect(apiHits).toHaveLength(1);
    expect(apiHits[0]!.memory.title).toBe('REST API service design');

    // "log" must NOT match "Dialog"
    const logHits = context(root, 'log', {});
    expect(logHits).toHaveLength(1);
    expect(logHits[0]!.memory.title).toBe('Audit log storage');
  });
  it('correctly matches -ing queries to root words (testing -> test)', () => {
    const root = setup();
    remember(root, { title: 'Unit test execution standards', text: 'Run vitest on all PR branches.', type: 'convention' });
    remember(root, { title: 'Docker build optimization', text: 'Cache layers effectively.', type: 'lesson' });

    const testHits = context(root, 'testing', {});
    expect(testHits).toHaveLength(1);
    expect(testHits[0]!.memory.title).toBe('Unit test execution standards');

    const buildHits = context(root, 'building', {});
    expect(buildHits).toHaveLength(1);
    expect(buildHits[0]!.memory.title).toBe('Docker build optimization');
  });
  it('filters by type and tag', () => {
    const root = setup();
    remember(root, { title: 'Auth session cookie storage', text: 'Store tokens in httpOnly cookies.', type: 'decision', tags: ['auth', 'security'] });
    remember(root, { title: 'Auth token expiration bug', text: 'Expired tokens crash session.', type: 'bugfix', tags: ['auth'] });
    remember(root, { title: 'Database schema migration', text: 'Run migrations on boot.', type: 'decision', tags: ['database'] });

    const allAuth = context(root, 'auth', {});
    expect(allAuth).toHaveLength(2);

    const decisionOnly = context(root, 'auth', { type: 'decision' });
    expect(decisionOnly).toHaveLength(1);
    expect(decisionOnly[0]!.memory.type).toBe('decision');

    const bugfixOnly = context(root, 'auth', { type: 'bugfix' });
    expect(bugfixOnly).toHaveLength(1);
    expect(bugfixOnly[0]!.memory.type).toBe('bugfix');

    const securityTagOnly = context(root, 'auth', { tag: 'security' });
    expect(securityTagOnly).toHaveLength(1);
    expect(securityTagOnly[0]!.memory.title).toBe('Auth session cookie storage');
  });
});

describe('index', () => {
  it('rebuilds deterministically and preserves user text', () => {
    const root = setup();
    remember(root, { title: 'B decision', text: 'x', type: 'decision' });
    remember(root, { title: 'A lesson', text: 'y', type: 'lesson' });
    const file = path.join(root, '.recall', 'INDEX.md');
    fs.appendFileSync(file, '\n## My notes\nkeep me\n');
    rebuildIndex(path.join(root, '.recall'));
    const first = fs.readFileSync(file, 'utf8');
    rebuildIndex(path.join(root, '.recall'));
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    expect(first).toContain('keep me');
    expect(first).toContain('[B decision](decisions/');
    expect(indexState(path.join(root, '.recall'))).toBe('up_to_date');
  });
  it('detects stale index and broken links without deleting anything', () => {
    const root = setup();
    const m = remember(root, { title: 'X', text: 'y' });
    fs.rmSync(path.join(root, '.recall', m.file));
    expect(indexState(path.join(root, '.recall'))).toBe('stale');
    expect(brokenIndexLinks(path.join(root, '.recall'))).toContain(m.file);
    fs.writeFileSync(path.join(root, '.recall', 'lessons', 'broken.md'), '---\nid: nope\n---\n');
    const l = rebuildIndex(path.join(root, '.recall'));
    expect(l.problems.length).toBe(1);
    expect(fs.existsSync(path.join(root, '.recall', 'lessons', 'broken.md'))).toBe(true);
  });
});

describe('lifecycle', () => {
  it('propose -> approve and archive keep files on disk', () => {
    const root = setup();
    const p = propose(root, { title: 'Agent idea', text: 'text' });
    expect(p.status).toBe('proposed');
    expect(approve(root, p.id).status).toBe('active');
    const a = archive(root, p.id);
    expect(a.status).toBe('archived');
    expect(fs.existsSync(path.join(root, '.recall', a.file))).toBe(true);
    expect(() => approve(root, 'mem_999')).toThrow(RecallError);
  });
});

describe('git + status + log', () => {
  it('reports only .recall changes and never modifies the repo', () => {
    const root = tmpProject({ git: true });
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'x');
    initProject(root);
    remember(root, { title: 'T', text: 'x' });
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
    const s = status(root);
    expect(s.git.isRepo).toBe(true);
    expect(s.git.changes!.join('\n')).toContain('.recall');
    expect(s.git.changes!.join('\n')).not.toContain('unrelated.txt');
    const after = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
    expect(after).toBe(before);
    expect(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout).toBe('');
  });
  it('shows committed history separately from uncommitted', () => {
    const root = tmpProject({ git: true });
    dirs.push(root);
    initProject(root);
    spawnSync('git', ['add', '.recall'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'add recall'], { cwd: root });
    remember(root, { title: 'New', text: 'x' });
    const r = log(root, 5);
    expect(r.source).toBe('git');
    expect(r.committed[0]!.subject).toBe('add recall');
    expect(r.uncommitted.length).toBeGreaterThan(0);
  });
  it('falls back to the changelog outside git', () => {
    const root = setup();
    remember(root, { title: 'Hello', text: 'x' });
    const r = log(root, 5);
    expect(r.source).toBe('changelog');
    expect(r.changelog[0]).toContain('remember mem_001');
  });
  it('undo reverts modifications and deletes untracked memory files', () => {
    const root = tmpProject({ git: true });
    dirs.push(root);
    initProject(root);
    spawnSync('git', ['add', '.recall'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'clean recall'], { cwd: root });
    remember(root, { title: 'Untracked note', text: 'should be deleted' });
    expect(fs.readdirSync(path.join(root, '.recall', 'lessons')).length).toBeGreaterThan(0);
    const res = undo(root);
    expect(res.ok).toBe(true);
    expect(fs.readdirSync(path.join(root, '.recall', 'lessons'))).toEqual(['.gitkeep']);
  });
  it('undo supports dry-run without modifying files', () => {
    const root = tmpProject({ git: true });
    dirs.push(root);
    initProject(root);
    spawnSync('git', ['add', '.recall'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'clean recall'], { cwd: root });
    remember(root, { title: 'Untracked note', text: 'should be deleted', type: 'lesson' });
    const dry = undo(root, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.cleaned!.length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(root, '.recall', 'lessons')).length).toBeGreaterThan(1);
  });
});

describe('doctor', () => {
  it('passes on a fresh project and flags problems with fixes', () => {
    const root = setup();
    expect(runDoctor(root).filter((c) => !c.ok)).toEqual([]);
    fs.rmSync(path.join(root, '.recall', 'lessons'), { recursive: true });
    fs.writeFileSync(path.join(root, '.recall', 'config.json'), '{bad');
    const failed = runDoctor(root).filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toEqual(expect.arrayContaining(['config', 'directory lessons/']));
    expect(failed.every((c) => c.fix || c.detail)).toBe(true);
  });
  it('reports uninitialized projects', () => {
    const d = tmpProject();
    dirs.push(d);
    expect(runDoctor(d).some((c) => c.name === 'initialized' && !c.ok)).toBe(true);
  });
});

describe('mcp', () => {
  it('lists tools, searches, proposes, checkpoints, and returns status', () => {
    const root = setup();
    remember(root, { title: 'Render pipeline', text: 'keep rendering pure' });
    const list = handleMessage(root, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      'recall_context',
      'recall_propose',
      'recall_checkpoint',
      'recall_map',
      'recall_status',
    ]);
    const res = handleMessage(root, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall_context', arguments: { query: 'render' } } }) as any;
    expect(res.result.content[0].text).toContain('Render pipeline');
    const prop = handleMessage(root, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall_propose', arguments: { title: 'P', text: 'x' } } }) as any;
    expect(prop.result.content[0].text).toContain('Proposed');
    expect(loadAll(path.join(root, '.recall')).memories.at(-1)!.status).toBe('proposed');
    const chk = handleMessage(root, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recall_checkpoint', arguments: { summary: 'Done task' } } }) as any;
    expect(chk.result.content[0].text).toContain('Checkpoint recorded');
    const stat = handleMessage(root, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'recall_status', arguments: {} } }) as any;
    expect(stat.result.content[0].text).toContain('Recall Status');
    expect(handleMessage(root, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});

describe('proposals batch operations', () => {
  it('handles getProposals, approveAll, and archiveAll', () => {
    const root = setup();
    propose(root, { title: 'First proposal', text: 'Proposal 1 text' });
    propose(root, { title: 'Second proposal', text: 'Proposal 2 text' });

    const props = getProposals(root);
    expect(props).toHaveLength(2);
    expect(props.map((p) => p.title)).toContain('First proposal');
    expect(props.map((p) => p.title)).toContain('Second proposal');

    // Approve all
    const approved = approveAll(root);
    expect(approved).toHaveLength(2);
    expect(approved.every((a) => a.status === 'active')).toBe(true);
    expect(getProposals(root)).toHaveLength(0);

    // Add another proposal and archive all
    propose(root, { title: 'Third proposal', text: 'Proposal 3 text' });
    expect(getProposals(root)).toHaveLength(1);
    const archived = archiveAll(root);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status === 'archived').toBe(true);
    expect(getProposals(root)).toHaveLength(0);
  });
});

describe('seed', () => {
  it('mines markdown docs into proposed memories', () => {
    const root = setup();
    const docDir = path.join(root, 'docs');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(
      path.join(docDir, 'architecture.md'),
      '# My System\n\n## Database Isolation\n\nAll database writes must go through the repository abstraction layer to allow mock testing.\n\n## Event Bus\n\nEvents are published synchronously in transaction boundaries.\n'
    );

    const res = seed(root, { from: 'docs' });
    expect(res.proposed.length).toBeGreaterThan(0);
    expect(res.proposed.some((p) => p.title === 'Database Isolation')).toBe(true);

    const proposals = getProposals(root);
    expect(proposals.some((p) => p.title === 'Database Isolation')).toBe(true);

    // Deduplication check: running seed again should not duplicate
    const res2 = seed(root, { from: 'docs' });
    expect(res2.proposed).toHaveLength(0);
  });

  it('supports dry-run mode without modifying disk', () => {
    const root = setup();
    const docDir = path.join(root, 'docs');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(
      path.join(docDir, 'adr.md'),
      '## Caching Strategy\n\nUse Redis memory cache with TTL of 1 hour for all product listing pages.\n'
    );

    const dry = seed(root, { from: 'docs', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.proposed.length).toBe(1);
    expect(dry.proposed[0]!.title).toBe('Caching Strategy');

    // Confirm nothing was written to disk
    expect(getProposals(root)).toHaveLength(0);
  });
});

describe('token footprint', () => {
  it('computes orientation token counts and adheres to budget across profile tiers', () => {
    const root = setup();
    const st = status(root);
    expect(st.tokens).toBeDefined();
    expect(st.profile).toBe('standard');
    expect(st.tokens.budgetTokens).toBe(12000);
    expect(st.tokens.totalTokens).toBeGreaterThan(0);
    expect(st.tokens.totalTokens).toBeLessThan(st.tokens.budgetTokens);
    expect(st.tokens.files['MEMORY.md']).toBeDefined();
    expect(st.tokens.files['INDEX.md']).toBeDefined();
  });
});

describe('no network', () => {
  it('source contains no network APIs', () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const src = walk(path.resolve(__dirname, '..', 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(src).not.toMatch(/node:(http|https|net|dgram|tls)['"]|\bfetch\(|XMLHttpRequest|WebSocket/);
  });
});
