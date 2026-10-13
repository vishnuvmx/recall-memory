import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanProject, buildProjectMapMarkdown, generateProjectMap } from '../src/core/mapper.js';
import { initProject } from '../src/core/init.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const mk = (): string => {
  const d = tmpProject();
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('mapper', () => {
  it('detects project type, entry points, config files, and directories', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(root, 'src', 'components', 'Button.tsx'), 'export const Button = () => null;');
    fs.writeFileSync(path.join(root, 'src', 'api', 'client.ts'), 'export const client = {};');

    const data = scanProject(root);
    expect(data.projectType).toContain('Node.js');
    expect(data.entryPoints).toContain('src/index.ts');
    expect(data.configFiles).toContain('package.json');
    expect(data.configFiles).toContain('tsconfig.json');
    expect(data.directories.map((d) => d.path)).toContain('src/components');

    const md = buildProjectMapMarkdown(data);
    expect(md).toContain('Primary Entry Points');
    expect(md).toContain('`src/index.ts`');
    expect(md).toContain('Directory Topology');
    expect(md).toContain('`src/components/`');
  });

  it('ignores node_modules and .git by default', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), '');

    const data = scanProject(root);
    const paths = data.directories.map((d) => d.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('generates PROJECT_MAP.md in .recall directory and is idempotent', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '');
    initProject(root);

    const mapFile = path.join(root, '.recall', 'PROJECT_MAP.md');
    expect(fs.existsSync(mapFile)).toBe(true);

    const content1 = fs.readFileSync(mapFile, 'utf8');
    expect(content1).toContain('recall:project-map:begin');
    expect(content1).toContain('`src/index.ts`');

    generateProjectMap(root, path.join(root, '.recall'));
    const content2 = fs.readFileSync(mapFile, 'utf8');
    expect(content2).toBe(content1);
  });

  it('enforces a hard character/token budget cap', () => {
    const root = mk();
    const data = scanProject(root);
    data.entryPoints = Array.from({ length: 50 }, (_, i) => `packages/pkg_${i}/src/main_${i}.ts`);
    const md = buildProjectMapMarkdown(data, 400);
    expect(md.length).toBeLessThanOrEqual(400);
    expect(md).toContain('Project map capped at 400 chars');
  });

  it('respects .gitignore patterns including trailing slashes and directory names', () => {
    const root = mk();
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\ncustom_build/\nignored_dir/\n*.generated.ts\n');
    fs.mkdirSync(path.join(root, 'dist', 'bundle'), { recursive: true });
    fs.mkdirSync(path.join(root, 'custom_build', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ignored_dir'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'code');
    fs.writeFileSync(path.join(root, 'custom_build', 'output.js'), 'code');
    fs.writeFileSync(path.join(root, 'ignored_dir', 'ignored.ts'), 'code');
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(root, 'src', 'auto.generated.ts'), 'export const b = 2;');

    const data = scanProject(root);
    const paths = data.directories.map((d) => d.path);
    expect(paths).toContain('src');
    expect(paths.some((p) => p.includes('dist'))).toBe(false);
    expect(paths.some((p) => p.includes('custom_build'))).toBe(false);
    expect(paths.some((p) => p.includes('ignored_dir'))).toBe(false);
  });
});
