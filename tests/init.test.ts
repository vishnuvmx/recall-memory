import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { findProject } from '../src/core/project.js';
import { loadConfig } from '../src/core/config.js';
import { agentState } from '../src/core/agent.js';
import { resolveInside, RecallError } from '../src/utils/fs.js';
import { applyManagedBlock } from '../src/utils/managed.js';
import { AGENT_BLOCK } from '../src/templates/index.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const mk = (o?: { git?: boolean }): string => {
  const d = tmpProject(o);
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('project discovery', () => {
  it('prefers nearest recall config over git root', () => {
    const root = mk({ git: true });
    const sub = path.join(root, 'pkg', 'a');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(root, 'pkg', '.recall'));
    fs.writeFileSync(path.join(root, 'pkg', '.recall', 'config.json'), '{"version":1}');
    expect(findProject(sub).root).toBe(path.join(root, 'pkg'));
    expect(findProject(sub).source).toBe('recall');
  });
  it('falls back to git root then cwd', () => {
    const root = mk({ git: true });
    const sub = path.join(root, 'x');
    fs.mkdirSync(sub);
    expect(findProject(sub).source).toBe('git');
    expect(findProject(sub).root).toBe(root);
    const plain = mk();
    expect(findProject(plain).source).toBe('cwd');
  });
});

describe('init', () => {
  it('creates the structure and is idempotent', () => {
    const root = mk({ git: true });
    const a = initProject(root);
    expect(a.created.length).toBeGreaterThan(5);
    for (const f of ['config.json', 'MEMORY.md', 'INDEX.md', 'PROJECT_MAP.md', 'CURRENT_STATE.md', 'rules/architecture.md', 'logs/CHANGELOG.md']) {
      expect(fs.existsSync(path.join(root, '.recall', f))).toBe(true);
    }
    const agents1 = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(fs.existsSync(path.join(root, '.agents', 'rules', 'recall.md'))).toBe(false); // No duplicate always-on injection
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'recall', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.agents', 'hooks.json'))).toBe(true);
    const b = initProject(root);
    expect(b.created).toEqual([]);
    expect(b.agent).toBe('unchanged');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(agents1);
    expect((agents1.match(/recall:begin/g) ?? []).length).toBe(1);
  });
  it('never overwrites edited files and preserves existing AGENTS.md', () => {
    const root = mk();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# My rules\n\nBe nice.\n');
    initProject(root);
    fs.writeFileSync(path.join(root, '.recall', 'MEMORY.md'), 'mine');
    initProject(root);
    expect(fs.readFileSync(path.join(root, '.recall', 'MEMORY.md'), 'utf8')).toBe('mine');
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# My rules\n\nBe nice.')).toBe(true);
    expect(agentState(root, 'AGENTS.md')).toBe('installed');
  });
  it('does not create git state or stage anything', () => {
    const root = mk();
    initProject(root);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });
  it('supports --no-agent', () => {
    const root = mk();
    expect(initProject(root, { agent: false }).agent).toBe('skipped');
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });
  it('automatically bridges existing CLAUDE.md to @AGENTS.md', () => {
    const root = mk();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude Rules\n');
    initProject(root);
    const claudeContent = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeContent).toContain('@AGENTS.md');
  });
  it('refuses a malformed config instead of overwriting it', () => {
    const root = mk();
    initProject(root);
    const cfg = path.join(root, '.recall', 'config.json');
    fs.writeFileSync(cfg, '{ nope');
    expect(() => initProject(root)).toThrow(RecallError);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{ nope');
    fs.writeFileSync(cfg, JSON.stringify({ version: 2 }));
    expect(() => loadConfig(path.join(root, '.recall'))).toThrow(/Invalid config/);
  });
  it('keeps the agent block compact (< 4 KB)', () => {
    expect(Buffer.byteLength(AGENT_BLOCK)).toBeLessThan(4096);
  });
  it('refuses malformed managed markers', () => {
    expect(() => applyManagedBlock('<!-- recall:begin -->\nx', 'y')).toThrow(RecallError);
  });
});

describe('path safety', () => {
  it('rejects traversal', () => {
    const root = mk();
    expect(() => resolveInside(root, '..', 'evil')).toThrow(RecallError);
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow(RecallError);
    if (process.platform === 'win32') expect(() => resolveInside(root, '..\\..\\evil')).toThrow(RecallError);
  });
  it('rejects symlink escapes', () => {
    const root = mk();
    const outside = mk();
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      return; // symlinks unavailable in this environment
    }
    expect(() => resolveInside(root, 'link', 'file.md')).toThrow(RecallError);
  });
  it('handles unicode directories', () => {
    const root = mk();
    const u = path.join(root, 'проект-日本語');
    fs.mkdirSync(u);
    initProject(u);
    expect(fs.existsSync(path.join(u, '.recall', 'config.json'))).toBe(true);
  });
});
