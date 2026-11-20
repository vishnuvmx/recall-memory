import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '../utils/fs.js';
import { DEFAULT_IGNORED_DIRS, TEST_FILE_REGEX, createGitignoreFilter } from './mapper.js';


export interface Landmark {
  name: string;
  kind: 'class' | 'method' | 'function' | 'section' | 'interface' | 'type' | 'const';
  line: number;
  exported?: boolean;
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
    const rawLine = lines[i]!;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
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
        const name = classMatch[1]!;
        landmarks.push({ name, kind: 'class', line: lineNum, exported: !name.startsWith('_') });
        continue;
      }
      // Methods / Functions
      const methodMatch = /^(?:(?:static|override|final|late|const)\s+)*(?:[A-Za-z0-9_<>?]+\s+)?(_?[a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:async\s*)?(?:=>|\{)/.exec(line);
      if (methodMatch) {
        const name = methodMatch[1]!;
        if (!['if', 'for', 'while', 'switch', 'catch', 'when', 'assert', 'setState'].includes(name)) {
          landmarks.push({ name, kind: 'method', line: lineNum, exported: indent === 0 && !name.startsWith('_') });
        }
      }
    } else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
      const isExported = line.startsWith('export ');
      // Classes
      const classMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/.exec(line);
      if (classMatch) {
        landmarks.push({ name: classMatch[1]!, kind: 'class', line: lineNum, exported: isExported });
        continue;
      }
      // Interfaces
      const ifaceMatch = /^(?:export\s+)?interface\s+([A-Za-z0-9_]+)/.exec(line);
      if (ifaceMatch) {
        landmarks.push({ name: ifaceMatch[1]!, kind: 'interface', line: lineNum, exported: isExported });
        continue;
      }
      // Types
      const typeMatch = /^(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*(?:<[^=]+>)?\s*=/.exec(line);
      if (typeMatch) {
        landmarks.push({ name: typeMatch[1]!, kind: 'type', line: lineNum, exported: isExported });
        continue;
      }
      // Functions / Arrow functions (skip nested inner helper functions when indented and unexported)
      const fnMatch = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*|\s+([A-Za-z0-9_$]+))\s*(?:\(|<)/.exec(line);
      if (fnMatch && fnMatch[1]) {
        if (isExported || indent === 0) {
          landmarks.push({ name: fnMatch[1]!, kind: 'function', line: lineNum, exported: isExported });
        }
        continue;
      }
      const constFnMatch =
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:<[^>]+>\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*(?::\s*[^=]+)?\s*=>/.exec(
          line,
        );
      if (constFnMatch) {
        if (isExported || indent === 0) {
          landmarks.push({ name: constFnMatch[1]!, kind: 'function', line: lineNum, exported: isExported });
        }
        continue;
      }
      // Exported enums and constants (e.g. export const DEFAULT_TIMEOUT = 60; export enum Mode {)
      if (isExported && indent === 0) {
        const exportEnumConst = /^export\s+(?:const|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
        if (exportEnumConst && exportEnumConst[1]) {
          landmarks.push({ name: exportEnumConst[1]!, kind: 'const', line: lineNum, exported: true });
          continue;
        }
      }
      // Class methods (with optional access/async/static modifiers at class-body indentation)
      if (indent >= 2 && indent <= 4) {
        const methodMatch =
          /^(?:(?:public|private|protected|static|async|\*|override|readonly|get|set)\s+)*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]+>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{/.exec(
            line,
          );
        if (methodMatch && methodMatch[1]) {
          const name = methodMatch[1]!;
          if (
            ![
              'if',
              'for',
              'while',
              'switch',
              'catch',
              'constructor',
              'return',
              'throw',
              'else',
              'try',
              'finally',
              'do',
              'new',
              'function',
            ].includes(name)
          ) {
            landmarks.push({ name, kind: 'method', line: lineNum, exported: false });
          }
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

const LANDMARK_CACHE_VERSION = 5;

export interface CacheRecord {
  v?: number;
  size?: number;
  mtimeMs: number;
  ctimeMs?: number;
  totalLines: number;
  landmarks: Landmark[];
}

export interface OtherFileRecord {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  totalLines?: number;
}

export interface LandmarksCacheStore {
  v: number;
  gitignoreStat: string;
  files: Record<string, CacheRecord>;
  otherFiles: Record<string, OtherFileRecord>;
}

/** Fast stat-only key for `.gitignore` (catches changes to ignore rules in 1 statSync call). */
export function computeGitignoreStatKey(root: string): string {
  const file = path.join(root, '.gitignore');
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.floor(st.mtimeMs)}:${Math.floor(st.ctimeMs)}`;
  } catch {
    return 'none';
  }
}

export function isCacheStatFresh(
  cached: { size?: number; mtimeMs: number; ctimeMs?: number; v?: number } | undefined,
  stat: fs.Stats,
  requireVersion = false,
): boolean {
  if (!cached) return false;
  if (requireVersion && cached.v !== LANDMARK_CACHE_VERSION) return false;
  if (cached.size !== stat.size) return false;
  if (Math.floor(cached.mtimeMs) !== Math.floor(stat.mtimeMs)) return false;
  if (cached.ctimeMs !== undefined && Math.floor(cached.ctimeMs) !== Math.floor(stat.ctimeMs)) return false;
  return true;
}

type CompactLandmarkTuple = [string, number, number, 0 | 1];
const KIND_TO_CODE: Record<Landmark['kind'], number> = {
  class: 0,
  method: 1,
  function: 2,
  section: 3,
  interface: 4,
  type: 5,
  const: 6,
};
const CODE_TO_KIND: Landmark['kind'][] = ['class', 'method', 'function', 'section', 'interface', 'type', 'const'];

interface SerializedLandmarksCache {
  v: number;
  gitignoreStat: string;
  files: Record<string, [number, number, number, number, CompactLandmarkTuple[]]>;
  otherFiles: Record<string, [number, number, number]>;
}

const memoryCacheByPath = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; store: LandmarksCacheStore }>();

export function landmarksCachePath(recallDir: string): string {
  return path.join(recallDir, '.cache', 'landmarks-cache.json');
}

export function loadLandmarksCache(recallDir: string): LandmarksCacheStore | null {
  const cacheFile = landmarksCachePath(recallDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cacheFile);
  } catch {
    memoryCacheByPath.delete(cacheFile);
    return null;
  }

  const memHit = memoryCacheByPath.get(cacheFile);
  if (
    memHit &&
    memHit.mtimeMs === stat.mtimeMs &&
    memHit.ctimeMs === stat.ctimeMs &&
    memHit.size === stat.size
  ) {
    return memHit.store;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Partial<SerializedLandmarksCache>;
    if (
      parsed &&
      parsed.v === LANDMARK_CACHE_VERSION &&
      typeof parsed.gitignoreStat === 'string' &&
      parsed.files &&
      typeof parsed.files === 'object' &&
      parsed.otherFiles &&
      typeof parsed.otherFiles === 'object'
    ) {
      const files: Record<string, CacheRecord> = {};
      for (const [rel, tup] of Object.entries(parsed.files)) {
        if (!Array.isArray(tup) || tup.length < 5) continue;
        const [size, mtimeMs, ctimeMs, totalLines, lms] = tup;
        files[rel] = {
          v: LANDMARK_CACHE_VERSION,
          size,
          mtimeMs,
          ctimeMs,
          totalLines,
          landmarks: lms.map(([name, kindCode, line, exp]) => ({
            name,
            kind: CODE_TO_KIND[kindCode] ?? 'function',
            line,
            ...(exp === 1 ? { exported: true } : {}),
          })),
        };
      }
      const otherFiles: Record<string, OtherFileRecord> = {};
      for (const [rel, tup] of Object.entries(parsed.otherFiles)) {
        if (!Array.isArray(tup) || tup.length < 3) continue;
        otherFiles[rel] = { size: tup[0], mtimeMs: tup[1], ctimeMs: tup[2] };
      }
      const store: LandmarksCacheStore = {
        v: LANDMARK_CACHE_VERSION,
        gitignoreStat: parsed.gitignoreStat,
        files,
        otherFiles,
      };
      memoryCacheByPath.set(cacheFile, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, store });
      return store;
    }
  } catch {
    // ignore corrupt or older cache version
  }
  return null;
}

export function saveLandmarksCache(recallDir: string, store: LandmarksCacheStore): void {
  const cacheFile = landmarksCachePath(recallDir);
  try {
    const cacheDir = path.dirname(cacheFile);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const files: SerializedLandmarksCache['files'] = {};
    for (const [rel, rec] of Object.entries(store.files)) {
      files[rel] = [
        rec.size ?? 0,
        rec.mtimeMs,
        rec.ctimeMs ?? rec.mtimeMs,
        rec.totalLines,
        rec.landmarks.map((lm) => [lm.name, KIND_TO_CODE[lm.kind] ?? 2, lm.line, lm.exported ? 1 : 0]),
      ];
    }
    const otherFiles: SerializedLandmarksCache['otherFiles'] = {};
    for (const [rel, rec] of Object.entries(store.otherFiles)) {
      otherFiles[rel] = [rec.size, rec.mtimeMs, rec.ctimeMs ?? rec.mtimeMs];
    }
    const serialized: SerializedLandmarksCache = {
      v: LANDMARK_CACHE_VERSION,
      gitignoreStat: store.gitignoreStat,
      files,
      otherFiles,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(serialized), 'utf8');
    const st = fs.statSync(cacheFile);
    memoryCacheByPath.set(cacheFile, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, store });
  } catch {
    // ignore cache write failures
  }
}

function exportedSignature(landmarks: Landmark[]): string {
  return landmarks
    .filter((lm) => lm.kind !== 'section')
    .map((lm) => `${lm.exported ? 'E' : 'I'}:${lm.kind}:${lm.name}`)
    .join(',');
}

export function materializeFileLandmarks(
  store: LandmarksCacheStore,
  minLines = 1,
  maxFiles = Number.POSITIVE_INFINITY,
  maxSymbols = Number.POSITIVE_INFINITY,
): FileLandmarks[] {
  const results: FileLandmarks[] = [];
  for (const [rel, rec] of Object.entries(store.files)) {
    if (rec.totalLines >= minLines && rec.landmarks.length > 0) {
      results.push({
        relativePath: rel,
        totalLines: rec.totalLines,
        landmarks: maxSymbols === Number.POSITIVE_INFINITY ? rec.landmarks : rec.landmarks.slice(0, maxSymbols),
      });
    }
  }
  results.sort((a, b) => b.totalLines - a.totalLines);
  return maxFiles === Number.POSITIVE_INFINITY ? results : results.slice(0, maxFiles);
}

/**
 * Reads cached FileLandmarks directly from `.recall/.cache/landmarks-cache.json` with 0 directory walks.
 * Returns null if no valid v3 cache exists yet.
 */
export function readCachedLandmarks(
  recallDir: string,
  minLines = 1,
  maxFiles = Number.POSITIVE_INFINITY,
  maxSymbols = Number.POSITIVE_INFINITY,
): FileLandmarks[] | null {
  const store = loadLandmarksCache(recallDir);
  if (!store) return null;
  return materializeFileLandmarks(store, minLines, maxFiles, maxSymbols);
}

export interface IncrementalLandmarksResult {
  files: FileLandmarks[];
  store: LandmarksCacheStore;
  changedCount: number;
  deletedCount: number;
  exportedSurfaceChanged: boolean;
}

/**
 * Incrementally updates `.recall/.cache/landmarks-cache.json` (both code symbols and non-code file paths).
 * - If `opts.changedFiles` is provided AND a valid v3 cache exists, updates ONLY those specific files
 *   with ZERO repository directory walks!
 * - Otherwise performs ONE unified walk across the project tree, reading only files whose mtime or size changed.
 */
export function syncLandmarksIncremental(
  root: string,
  recallDir?: string,
  opts: {
    changedFiles?: string[];
    minLines?: number;
    maxFiles?: number;
    maxSymbols?: number;
  } = {},
): IncrementalLandmarksResult {
  const minLines = opts.minLines ?? 1;
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxSymbols = opts.maxSymbols ?? Number.POSITIVE_INFINITY;

  const currentGitignoreStat = computeGitignoreStatKey(root);
  const existingStore = recallDir ? loadLandmarksCache(recallDir) : null;
  const gitignoreChanged = !existingStore || existingStore.gitignoreStat !== currentGitignoreStat;
  const store: LandmarksCacheStore = existingStore ?? {
    v: LANDMARK_CACHE_VERSION,
    gitignoreStat: currentGitignoreStat,
    files: {},
    otherFiles: {},
  };
  store.gitignoreStat = currentGitignoreStat;

  let cacheDirty = !existingStore || gitignoreChanged;
  let changedCount = 0;
  let deletedCount = 0;
  let exportedSurfaceChanged = !existingStore;

  const updateSingleFile = (rel: string, fullPath: string, isGitignored: (r: string, isDir: boolean) => boolean): void => {
    const base = path.basename(rel);
    if (isGitignored(rel, false) || TEST_FILE_REGEX.test(base)) {
      if (store.files[rel]) {
        delete store.files[rel];
        deletedCount++;
        exportedSurfaceChanged = true;
        cacheDirty = true;
      }
      if (store.otherFiles[rel]) {
        delete store.otherFiles[rel];
        deletedCount++;
        cacheDirty = true;
      }
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      if (store.files[rel]) {
        delete store.files[rel];
        deletedCount++;
        exportedSurfaceChanged = true;
        cacheDirty = true;
      }
      if (store.otherFiles[rel]) {
        delete store.otherFiles[rel];
        deletedCount++;
        cacheDirty = true;
      }
      return;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;

    const ext = path.extname(base).toLowerCase();
    if (SUPPORTED_EXTS.has(ext)) {
      const cached = store.files[rel];
      if (!isCacheStatFresh(cached, stat, true)) {
        const oldSig = cached ? exportedSignature(cached.landmarks) : '';
        const content = fs.readFileSync(fullPath, 'utf8');
        const linesCount = content.split('\n').length;
        const landmarks = extractLandmarks(content, ext);
        const newSig = exportedSignature(landmarks);
        if (!cached || oldSig !== newSig) {
          exportedSurfaceChanged = true;
        }
        store.files[rel] = {
          v: LANDMARK_CACHE_VERSION,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          totalLines: linesCount,
          landmarks,
        };
        changedCount++;
        cacheDirty = true;
      }
    } else {
      const cached = store.otherFiles[rel];
      if (!isCacheStatFresh(cached, stat, false)) {
        store.otherFiles[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        changedCount++;
        cacheDirty = true;
      }
    }
  };

  // Fast-path: caller already knows exact changed paths (e.g., from git status) and .gitignore hasn't changed
  if (existingStore && !gitignoreChanged && opts.changedFiles) {
    if (opts.changedFiles.length > 0) {
      const isGitignored = createGitignoreFilter(root);
      for (const rawRel of opts.changedFiles) {
        const rel = toPosix(rawRel).replace(/^\/+/, '');
        if (!rel || rel.startsWith('.recall/')) continue;
        const topSeg = rel.split('/')[0] ?? '';
        if (DEFAULT_IGNORED_DIRS.has(topSeg)) continue;
        updateSingleFile(rel, path.join(root, rel), isGitignored);
      }
      if (recallDir && cacheDirty) {
        saveLandmarksCache(recallDir, store);
      }
    }
    return {
      files: materializeFileLandmarks(store, minLines, maxFiles, maxSymbols),
      store,
      changedCount,
      deletedCount,
      exportedSurfaceChanged,
    };
  }

  // Unified single-pass repository walk (populates BOTH code landmarks and non-code files)
  const seenCode = new Set<string>();
  const seenOther = new Set<string>();
  const isGitignored = createGitignoreFilter(root);

  function walk(currentDir: string, depth: number): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const rel = toPosix(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isGitignored(rel, true)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (isGitignored(rel, false) || TEST_FILE_REGEX.test(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          seenCode.add(rel);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) continue;
            const cached = store.files[rel];
            if (!isCacheStatFresh(cached, stat, true)) {
              const oldSig = cached ? exportedSignature(cached.landmarks) : '';
              const content = fs.readFileSync(fullPath, 'utf8');
              const linesCount = content.split('\n').length;
              const landmarks = extractLandmarks(content, ext);
              if (!cached || oldSig !== exportedSignature(landmarks)) {
                exportedSurfaceChanged = true;
              }
              store.files[rel] = {
                v: LANDMARK_CACHE_VERSION,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                totalLines: linesCount,
                landmarks,
              };
              changedCount++;
              cacheDirty = true;
            }
          } catch {
            // ignore unreadable
          }
        } else if (depth <= 5) {
          seenOther.add(rel);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) continue;
            const cached = store.otherFiles[rel];
            if (!isCacheStatFresh(cached, stat, false)) {
              store.otherFiles[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
              changedCount++;
              cacheDirty = true;
            }
          } catch {
            // ignore unreadable
          }
        }
      }
    }
  }

  walk(root, 0);

  // Evict deleted or newly ignored files
  for (const key of Object.keys(store.files)) {
    if (!seenCode.has(key)) {
      delete store.files[key];
      deletedCount++;
      exportedSurfaceChanged = true;
      cacheDirty = true;
    }
  }
  for (const key of Object.keys(store.otherFiles)) {
    if (!seenOther.has(key)) {
      delete store.otherFiles[key];
      deletedCount++;
      cacheDirty = true;
    }
  }

  if (recallDir && cacheDirty) {
    saveLandmarksCache(recallDir, store);
  }

  return {
    files: materializeFileLandmarks(store, minLines, maxFiles, maxSymbols),
    store,
    changedCount,
    deletedCount,
    exportedSurfaceChanged,
  };
}

/**
 * Scans the project for files (>= minLines) and extracts landmark locations with MTime caching.
 */
export function scanLandmarks(
  root: string,
  minLines = 300,
  maxFiles = 5,
  maxSymbols = 12,
  recallDir?: string,
): FileLandmarks[] {
  return syncLandmarksIncremental(root, recallDir, { minLines, maxFiles, maxSymbols }).files;
}

export function formatLandmarksMarkdown(files: FileLandmarks[]): string {
  if (files.length === 0) return '';

  const lines: string[] = [
    '## Large File Landmarks & Codebase API Surface (Direct Jump Targets)',
    '> **AI AGENTS**: Do NOT grep inside these files or re-read them to discover APIs. Use these line numbers and symbol signatures directly.',
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
