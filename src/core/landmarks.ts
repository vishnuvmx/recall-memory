import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '../utils/fs.js';
import { DEFAULT_IGNORED_DIRS, createGitignoreFilter } from './mapper.js';

export interface Landmark {
  name: string;
  kind: 'class' | 'method' | 'function' | 'section';
  line: number;
}

export interface FileLandmarks {
  relativePath: string;
  totalLines: number;
  landmarks: Landmark[];
}

const SUPPORTED_EXTS = new Set([
  '.dart',
  '.kt',
  '.java',
  '.swift',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.cs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.php',
  '.rb',
]);

/**
 * Extracts key landmark symbols from a source file using fast regex pattern matching.
 */
export function extractLandmarks(content: string, ext: string): Landmark[] {
  const lines = content.split('\n');
  const landmarks: Landmark[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i]!.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      // Check for explicit section comments (e.g. // MARK: or // ===)
      if (line.includes('MARK:') || line.startsWith('// ===') || line.startsWith('// ---') || line.includes('SECTION:')) {
        const clean = line.replace(/^\/\/\s*[-=]*\s*/, '').replace(/[-=]*$/, '').trim();
        if (clean.length > 3 && clean.length < 50) {
          landmarks.push({ name: clean, kind: 'section', line: lineNum });
        }
      }
      continue;
    }

    if (ext === '.dart') {
      // Classes
      const classMatch = /^(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/.exec(line);
      if (classMatch) {
        landmarks.push({ name: classMatch[1]!, kind: 'class', line: lineNum });
        continue;
      }
      // Methods / Functions
      const methodMatch = /^(?:(?:static|override|final|late|const)\s+)*(?:[A-Za-z0-9_<>?]+\s+)?(_?[a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:async\s*)?(?:=>|\{)/.exec(line);
      if (methodMatch) {
        const name = methodMatch[1]!;
        if (!['if', 'for', 'while', 'switch', 'catch', 'when', 'assert', 'setState'].includes(name)) {
          landmarks.push({ name, kind: 'method', line: lineNum });
        }
      }
    } else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
      // Classes
      const classMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/.exec(line);
      if (classMatch) {
        landmarks.push({ name: classMatch[1]!, kind: 'class', line: lineNum });
        continue;
      }
      // Functions / Arrow functions / Methods
      const fnMatch = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*|\s+([A-Za-z0-9_]+))\s*(?:\(|<)/.exec(line);
      if (fnMatch && fnMatch[1]) {
        landmarks.push({ name: fnMatch[1]!, kind: 'function', line: lineNum });
        continue;
      }
      const constFnMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/.exec(line);
      if (constFnMatch) {
        landmarks.push({ name: constFnMatch[1]!, kind: 'function', line: lineNum });
        continue;
      }
      const methodMatch = /^\s*(?:(?:public|private|protected|static|async|\*|override|readonly)\s+)+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/.exec(line);
      if (methodMatch) {
        const name = methodMatch[1]!;
        if (!['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) {
          landmarks.push({ name, kind: 'method', line: lineNum });
        }
      }
    } else if (ext === '.kt') {
      const ktClass = /^(?:(?:data|sealed|open|abstract|internal|public|private)\s+)*(?:class|interface|object)\s+([A-Za-z0-9_]+)/.exec(line);
      if (ktClass) {
        landmarks.push({ name: ktClass[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const ktFn = /^(?:(?:override|open|suspend|private|public|internal)\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (ktFn) {
        landmarks.push({ name: ktFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.java') {
      const javaClass = /^(?:public|protected|private)?\s*(?:static)?\s*(?:abstract|final)?\s*(?:class|interface|enum)\s+([A-Za-z0-9_]+)/.exec(line);
      if (javaClass) {
        landmarks.push({ name: javaClass[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const javaMethod = /^(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:[A-Za-z0-9_<>[\],]+\s+)+([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/.exec(line);
      if (javaMethod) {
        landmarks.push({ name: javaMethod[1]!, kind: 'method', line: lineNum });
      }
    } else if (ext === '.swift') {
      const swiftType = /^(?:public|private|internal|open|final)?\s*(?:class|struct|enum|protocol|extension)\s+([A-Za-z0-9_]+)/.exec(line);
      if (swiftType) {
        landmarks.push({ name: swiftType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const swiftFn = /^(?:public|private|internal|override|static)?\s*func\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (swiftFn) {
        landmarks.push({ name: swiftFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.py') {
      const pyClass = /^\s*class\s+([A-Za-z0-9_]+)/.exec(line);
      if (pyClass) {
        landmarks.push({ name: pyClass[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const pyFn = /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (pyFn) {
        landmarks.push({ name: pyFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.go') {
      const goType = /^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/.exec(line);
      if (goType) {
        landmarks.push({ name: goType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const goFn = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)/.exec(line);
      if (goFn) {
        landmarks.push({ name: goFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.rs') {
      const rsType = /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/.exec(line);
      if (rsType) {
        landmarks.push({ name: rsType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const rsFn = /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/.exec(line);
      if (rsFn) {
        landmarks.push({ name: rsFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.cs') {
      const csType = /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*(?:class|interface|struct|record)\s+([A-Za-z0-9_]+)/.exec(line);
      if (csType) {
        landmarks.push({ name: csType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const csMethod = /^(?:(?:public|private|protected|internal|static|virtual|override|async)\s+)+[A-Za-z0-9_<>?[\]]+\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:=>|\{)/.exec(line);
      if (csMethod) {
        landmarks.push({ name: csMethod[1]!, kind: 'method', line: lineNum });
      }
    } else if (ext === '.c' || ext === '.cpp' || ext === '.h' || ext === '.hpp') {
      const cppType = /^(?:class|struct)\s+([A-Za-z0-9_]+)\s*(?::|\{)/.exec(line);
      if (cppType) {
        landmarks.push({ name: cppType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const cppFn = /^(?:[A-Za-z0-9_*&<>]+\s+)+([A-Za-z0-9_]+)\s*\([^;)]*\)\s*(?:const)?\s*\{/.exec(line);
      if (cppFn && !['if', 'for', 'while', 'switch', 'catch'].includes(cppFn[1]!)) {
        landmarks.push({ name: cppFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.php') {
      const phpClass = /^(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z0-9_]+)/.exec(line);
      if (phpClass) {
        landmarks.push({ name: phpClass[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const phpFn = /^(?:(?:public|protected|private|static|final)\s+)*function\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (phpFn) {
        landmarks.push({ name: phpFn[1]!, kind: 'function', line: lineNum });
      }
    } else if (ext === '.rb') {
      const rbType = /^\s*(?:class|module)\s+([A-Za-z0-9_:]+)/.exec(line);
      if (rbType) {
        landmarks.push({ name: rbType[1]!, kind: 'class', line: lineNum });
        continue;
      }
      const rbMethod = /^\s*def\s+([A-Za-z0-9_!?.]+)/.exec(line);
      if (rbMethod) {
        landmarks.push({ name: rbMethod[1]!, kind: 'method', line: lineNum });
      }
    }
  }

  return landmarks;
}

/**
 * Scans the project for large files (>= minLines) and extracts landmark locations.
 */
export function scanLandmarks(root: string, minLines = 300, maxFiles = 5, maxSymbols = 12): FileLandmarks[] {
  const results: FileLandmarks[] = [];
  const isGitignored = createGitignoreFilter(root);

  function walk(currentDir: string): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      const rel = toPosix(path.relative(root, path.join(currentDir, entry.name)));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isGitignored(rel, true)) continue;
        walk(path.join(currentDir, entry.name));
      } else if (entry.isFile()) {
        if (isGitignored(rel, false)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;

        try {
          const fullPath = path.join(currentDir, entry.name);
          const stat = fs.statSync(fullPath);
          if (stat.size > 2 * 1024 * 1024) continue; // skip files > 2 MB
          const content = fs.readFileSync(fullPath, 'utf8');
          const linesCount = content.split('\n').length;
          if (linesCount >= minLines) {
            const rel = toPosix(path.relative(root, fullPath));
            const landmarks = extractLandmarks(content, ext);
            if (landmarks.length > 0) {
              results.push({
                relativePath: rel,
                totalLines: linesCount,
                landmarks: landmarks.slice(0, maxSymbols),
              });
            }
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  walk(root);
  // Sort descending by totalLines so the biggest "god files" come first
  results.sort((a, b) => b.totalLines - a.totalLines);
  return results.slice(0, maxFiles);
}

export function formatLandmarksMarkdown(files: FileLandmarks[]): string {
  if (files.length === 0) return '';

  const lines: string[] = [
    '## Large File Landmarks (Direct Jump Targets)',
    '> **AI AGENTS**: Do NOT grep inside these files. Use these line numbers to jump directly to target functions and classes.',
    '',
  ];

  for (const f of files) {
    lines.push(`### \`${f.relativePath}\` (${f.totalLines.toLocaleString()} lines)`);
    for (const lm of f.landmarks) {
      lines.push(`- **L${lm.line}**: \`${lm.name}\` (${lm.kind})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
