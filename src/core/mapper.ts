import fs from 'node:fs';
import path from 'node:path';
import { scanLandmarks, formatLandmarksMarkdown, type FileLandmarks } from './landmarks.js';
import { loadConfig } from './config.js';
import { type ProfileTier } from '../schemas/index.js';
import { atomicWrite, resolveInside, toPosix } from '../utils/fs.js';
import { applyManagedBlock } from '../utils/managed.js';

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.recall',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.gemini',
  'target',
  'bin',
  'obj',
  'tests',
  'test',
  '__tests__',
  '__test__',
  'spec',
  'specs',
]);

export const TEST_FILE_REGEX = /\.(?:test|spec)\.[a-zA-Z0-9]+$|_(?:test|spec)\.[a-zA-Z0-9]+$/i;


const ENTRY_FILENAMES = new Set([
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'app.ts',
  'app.js',
  'main.py',
  'app.py',
  'main.go',
  'main.rs',
  'index.html',
  'main.dart',
  'mainactivity.kt',
  'mainactivity.java',
  'appdelegate.swift',
]);

const CONFIG_FILENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
]);

const THEME_FILENAMES = new Set([
  'app_theme.dart',
  'theme.dart',
  'app_colors.dart',
  'colors.dart',
  'typography.dart',
  'tokens.css',
  'theme.ts',
  'theme.js',
  'tailwind.config.js',
  'tailwind.config.ts',
]);

export interface DirectoryInfo {
  path: string;
  filesCount: number;
  extensions: string[];
}

export interface ProjectMapData {
  projectType: string;
  entryPoints: string[];
  configFiles: string[];
  themeFiles: string[];
  directories: DirectoryInfo[];
  treeView: string;
  landmarks: FileLandmarks[];
}

import ignore from 'ignore';

export function createGitignoreFilter(root: string): (relPath: string, isDir: boolean) => boolean {
  const ignoreFile = path.join(root, '.gitignore');
  const ig = ignore();
  if (fs.existsSync(ignoreFile)) {
    try {
      ig.add(fs.readFileSync(ignoreFile, 'utf8'));
    } catch {
      // ignore syntax issues
    }
  }
  return (relPath: string, isDir: boolean): boolean => {
    if (!relPath || relPath === '.') return false;
    const testPath = isDir ? (relPath.endsWith('/') ? relPath : `${relPath}/`) : relPath;
    try {
      return ig.ignores(testPath);
    } catch {
      return false;
    }
  };
}

export function parseGitignore(root: string): Set<string> {
  const ignoreFile = path.join(root, '.gitignore');
  const ignores = new Set<string>();
  if (!fs.existsSync(ignoreFile)) return ignores;
  const lines = fs.readFileSync(ignoreFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.replace(/^\/+|\/+$/g, '');
    if (cleaned && !cleaned.includes('*') && !cleaned.includes('/')) {
      ignores.add(cleaned);
    }
  }
  return ignores;
}

export interface ScanProjectOptions {
  profile?: ProfileTier;
  recallDir?: string;
}

export function scanProject(root: string, maxDepth = 3, opts?: ScanProjectOptions): ProjectMapData {
  const isGitignored = createGitignoreFilter(root);
  const entryPoints: string[] = [];
  const configFiles: string[] = [];
  const themeFiles: string[] = [];
  const directories: DirectoryInfo[] = [];
  const treeLines: string[] = [];

  function walk(currentDir: string, currentDepth: number, prefix: string): void {
    if (currentDepth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs: fs.Dirent[] = [];
    const files: fs.Dirent[] = [];
    const extCount = new Map<string, number>();

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const rel = toPosix(path.relative(root, path.join(currentDir, entry.name)));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isGitignored(rel, true)) continue;
        dirs.push(entry);
      } else if (entry.isFile()) {
        if (isGitignored(rel, false)) continue;
        files.push(entry);
        const ext = path.extname(entry.name).toLowerCase();
        if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);

        if (currentDepth <= 2 && CONFIG_FILENAMES.has(entry.name)) {
          configFiles.push(rel);
        }
        const lowerName = entry.name.toLowerCase();
        if (ENTRY_FILENAMES.has(lowerName) || lowerName.endsWith('sdk.kt') || lowerName.endsWith('plugin.kt')) {
          entryPoints.push(rel);
        }
        if (THEME_FILENAMES.has(lowerName)) {
          themeFiles.push(rel);
        }
      }
    }

    const relDir = toPosix(path.relative(root, currentDir));
    if (relDir && relDir !== '.') {
      const topExts = [...extCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([e]) => e);
      directories.push({
        path: relDir,
        filesCount: files.length,
        extensions: topExts,
      });
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i]!;
      const isLast = i === dirs.length - 1 && files.length === 0;
      const pointer = isLast ? '\\-- ' : '|-- ';
      treeLines.push(`${prefix}${pointer}${d.name}/`);
      walk(path.join(currentDir, d.name), currentDepth + 1, `${prefix}${isLast ? '    ' : '|   '}`);
    }

    if (currentDepth <= 1) {
      const displayFiles = files.slice(0, 6);
      for (let i = 0; i < displayFiles.length; i++) {
        const f = displayFiles[i]!;
        const isLast = i === displayFiles.length - 1 && displayFiles.length === files.length;
        const pointer = isLast ? '\\-- ' : '|-- ';
        treeLines.push(`${prefix}${pointer}${f.name}`);
      }
      if (files.length > displayFiles.length) {
        treeLines.push(`${prefix}\\-- ... (${files.length - displayFiles.length} more files)`);
      }
    }
  }

  walk(root, 0, '');

  let projectType = 'Generic project';
  if (fs.existsSync(path.join(root, 'pubspec.yaml'))) projectType = 'Flutter / Dart';
  else if (fs.existsSync(path.join(root, 'package.json'))) projectType = 'Node.js / TypeScript / JavaScript';
  else if (fs.existsSync(path.join(root, 'Cargo.toml'))) projectType = 'Rust';
  else if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) projectType = 'Python';
  else if (fs.existsSync(path.join(root, 'go.mod'))) projectType = 'Go';

  const profile = opts?.profile ?? 'standard';
  let minLines = 40;
  let maxFiles = 25;
  let maxSymbols = 16;

  if (profile === 'compact') {
    minLines = 300;
    maxFiles = 5;
    maxSymbols = 10;
  } else if (profile === 'frontier') {
    minLines = 15;
    maxFiles = 60;
    maxSymbols = 30;
  }

  const landmarks = scanLandmarks(root, minLines, maxFiles, maxSymbols, opts?.recallDir);

  return {
    projectType,
    entryPoints: [...new Set(entryPoints)].sort(),
    configFiles: [...new Set(configFiles)].sort(),
    themeFiles: [...new Set(themeFiles)].sort(),
    directories,
    treeView: treeLines.join('\n'),
    landmarks,
  };
}

export function buildProjectMapMarkdown(data: ProjectMapData, maxChars = 6000): string {
  // Priority 1: Core Header, Entry Points, Design Tokens, Configs
  const headerLines: string[] = [
    '# Project Map & Topology',
    '',
    '> **AI AGENTS**: Use this blueprint to locate files directly. **DO NOT** execute recursive `list_dir` or crawl directories.',
    '',
    `**Project Type**: ${data.projectType}`,
    '',
  ];

  if (data.entryPoints.length > 0) {
    headerLines.push('## Primary Entry Points');
    const shown = data.entryPoints.slice(0, 8);
    for (const ep of shown) headerLines.push(`- \`${ep}\``);
    if (data.entryPoints.length > 8) {
      headerLines.push(`- _... (${data.entryPoints.length - 8} more entry points)_`);
    }
    headerLines.push('');
  }

  if (data.themeFiles && data.themeFiles.length > 0) {
    headerLines.push('## Design System & Theme Tokens');
    headerLines.push('When modifying UI components, reuse tokens from:');
    const shown = data.themeFiles.slice(0, 5);
    for (const tf of shown) headerLines.push(`- \`${tf}\``);
    if (data.themeFiles.length > 5) {
      headerLines.push(`- _... (${data.themeFiles.length - 5} more theme files)_`);
    }
    headerLines.push('');
  }

  if (data.configFiles.length > 0) {
    headerLines.push('## Configuration Files');
    const shown = data.configFiles.slice(0, 8);
    for (const cf of shown) headerLines.push(`- \`${cf}\``);
    if (data.configFiles.length > 8) {
      headerLines.push(`- _... (${data.configFiles.length - 8} more config files)_`);
    }
    headerLines.push('');
  }

  // Priority 2: High-Value Landmarks (Placed before directory trees so they are protected)
  const landmarkSection = data.landmarks && data.landmarks.length > 0
    ? `${formatLandmarksMarkdown(data.landmarks)}\n`
    : '';

  // Priority 3: Directory Topology Table
  const dirTableLines: string[] = ['## Directory Topology'];
  if (data.directories.length === 0) {
    dirTableLines.push('_Flat directory structure._', '');
  } else {
    dirTableLines.push('| Directory | Files | Primary Extensions |');
    dirTableLines.push('| :--- | :--- | :--- |');
    const displayDirs = data.directories.slice(0, 15);
    for (const d of displayDirs) {
      const exts = d.extensions.length > 0 ? d.extensions.join(', ') : '-';
      dirTableLines.push(`| \`${d.path}/\` | ${d.filesCount} | ${exts} |`);
    }
    if (data.directories.length > 15) {
      dirTableLines.push(`| _... (${data.directories.length - 15} more subdirectories)_ | - | _(use targeted live search)_ |`);
    }
    dirTableLines.push('');
  }

  // Priority 4: Structural Directory Tree View (Lowest priority section, dropped first on budget pressure)
  const treeSection = data.treeView.trim()
    ? `## Directory Tree (Top Levels)\n\`\`\`text\n${data.treeView}\n\`\`\`\n\n`
    : '';

  // Assembly via Priority Budgeting
  let result = headerLines.join('\n') + (landmarkSection ? `${landmarkSection}\n` : '');

  // Add Directory Table if it fits within maxChars (leaving at least 300 chars buffer)
  const dirTableText = `${dirTableLines.join('\n')}\n`;
  if (result.length + dirTableText.length < maxChars) {
    result += dirTableText;
  } else {
    result += '## Directory Topology\n> _[Directory table omitted to protect landmark budget. Use live targeted search.]_\n\n';
  }

  // Add Directory Tree View only if remaining budget permits
  if (treeSection && result.length + treeSection.length < maxChars) {
    result += treeSection;
  } else if (treeSection) {
    const remaining = maxChars - result.length - 150;
    if (remaining > 200) {
      const cut = treeSection.slice(0, remaining);
      const lastNl = cut.lastIndexOf('\n');
      result += `${cut.slice(0, lastNl > 0 ? lastNl : cut.length)}\n\`\`\`\n> ... [Directory tree truncated to preserve landmark budget]\n\n`;
    }
  }

  // Hard safety bound
  if (result.length > maxChars) {
    const cut = result.slice(0, maxChars - 160);
    const lastNl = cut.lastIndexOf('\n');
    result = `${cut.slice(0, lastNl > 0 ? lastNl : cut.length)}\n\n> ... [Project map capped at ${maxChars} chars to protect prompt budget.]\n`;
  }

  return result;
}

export const MAP_BLOCK_NAME = 'recall:project-map';

export function renderProjectMap(existing: string, data: ProjectMapData, profile: ProfileTier = 'standard'): string {
  const maxChars = profile === 'compact' ? 5600 : profile === 'frontier' ? 80000 : 24000;
  const content = buildProjectMapMarkdown(data, maxChars);
  const base = existing.trim() === '' ? '# Project Map\n' : existing;
  return applyManagedBlock(base, content, MAP_BLOCK_NAME);
}

export function generateProjectMap(root: string, recallDir: string, profile?: ProfileTier): string {
  let effectiveProfile: ProfileTier = profile ?? 'standard';
  if (!profile) {
    try {
      effectiveProfile = loadConfig(recallDir).profile ?? 'standard';
    } catch {
      effectiveProfile = 'standard';
    }
  }
  const data = scanProject(root, 3, { profile: effectiveProfile, recallDir });
  const file = resolveInside(recallDir, 'PROJECT_MAP.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rendered = renderProjectMap(existing, data, effectiveProfile);
  atomicWrite(file, rendered);
  return file;
}
