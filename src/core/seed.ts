import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireInitialized } from './project.js';
import { propose } from './service.js';
import { loadAll, type Memory } from './memory.js';
import { findSecrets } from '../utils/secrets.js';
import type { MemoryType } from '../schemas/index.js';

export interface SeedOptions {
  from?: 'git' | 'docs' | 'all';
  limit?: number;
  dryRun?: boolean;
}

export interface SeedCandidate {
  title: string;
  text: string;
  type: MemoryType;
  tags: string[];
  source: string;
}

export interface SeedResult {
  proposed: Array<{ id?: string; title: string; type: string; source: string }>;
  candidates: SeedCandidate[];
  dryRun: boolean;
  sourcesUsed: string[];
}

const COMMIT_TYPE_MAP: Array<{ prefix: RegExp; type: MemoryType; tag: string }> = [
  { prefix: /^feat(\([^)]+\))?:\s*/i, type: 'decision', tag: 'feature' },
  { prefix: /^fix(\([^)]+\))?:\s*/i, type: 'bugfix', tag: 'bugfix' },
  { prefix: /^refactor(\([^)]+\))?:\s*/i, type: 'decision', tag: 'refactor' },
  { prefix: /^perf(\([^)]+\))?:\s*/i, type: 'lesson', tag: 'performance' },
  { prefix: /^arch(\([^)]+\))?:\s*/i, type: 'decision', tag: 'architecture' },
];

const IGNORED_SUBJECTS = [
  /^bump\b/i,
  /^merge\b/i,
  /^release\b/i,
  /^update dependencies/i,
  /^chore\b/i,
  /^wip\b/i,
  /^typo\b/i,
  /^format\b/i,
];

function extractGitCandidates(root: string, maxCommits = 40): SeedCandidate[] {
  let output = '';
  try {
    output = execFileSync('git', ['log', `-n`, String(maxCommits), '--pretty=format:%h|%ad|%s', '--date=short'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const lines = output.trim().split('\n').filter(Boolean);
  const candidates: SeedCandidate[] = [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const hash = parts[0]?.trim() ?? '';
    const date = parts[1]?.trim() ?? '';
    const subject = parts.slice(2).join('|').trim();

    if (!subject || IGNORED_SUBJECTS.some((re) => re.test(subject))) continue;

    let matchedType: MemoryType = 'decision';
    let matchedTag = 'git-history';
    let cleanTitle = subject;

    for (const mapping of COMMIT_TYPE_MAP) {
      if (mapping.prefix.test(subject)) {
        matchedType = mapping.type;
        matchedTag = mapping.tag;
        cleanTitle = subject.replace(mapping.prefix, '').trim();
        break;
      }
    }

    if (cleanTitle.length < 5) continue;
    // Capitalize first letter
    cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);

    const text = `Seeded from commit ${hash} (${date}):\n${subject}`;
    if (findSecrets(cleanTitle).length > 0 || findSecrets(text).length > 0) continue;

    candidates.push({
      title: cleanTitle.slice(0, 80),
      text,
      type: matchedType,
      tags: [matchedTag, 'seed'],
      source: `git:${hash}`,
    });
  }

  return candidates;
}

function extractDocsCandidates(root: string): SeedCandidate[] {
  const candidates: SeedCandidate[] = [];
  const searchDirs = ['docs', 'doc'];

  for (const d of searchDirs) {
    const absDir = path.join(root, d);
    if (!fs.existsSync(absDir)) continue;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(absDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of entries) {
      const fullPath = path.join(absDir, file);
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      // Look for H2/H3 headings that suggest decisions or architecture
      const sections = content.split(/\n(?=##\s+)/);
      for (const section of sections) {
        const match = /^##\s+([^\n]+)\n([\s\S]*)/.exec(section);
        if (!match) continue;
        const heading = match[1]?.trim() ?? '';
        const body = match[2]?.trim() ?? '';

        if (/^(overview|introduction|table of contents|license|links)/i.test(heading)) continue;
        if (body.length < 40) continue;

        const firstPara = body.split(/\n\s*\n/)[0]?.trim() ?? '';
        if (firstPara.length < 20) continue;

        const title = heading.slice(0, 80);
        const text = firstPara.slice(0, 500);

        if (findSecrets(title).length > 0 || findSecrets(text).length > 0) continue;

        candidates.push({
          title,
          text: `# ${heading}\n\n${text}\n\nSource: \`${d}/${file}\``,
          type: 'decision',
          tags: ['architecture', 'docs', 'seed'],
          source: `${d}/${file}`,
        });
      }
    }
  }

  return candidates;
}

export function seed(start: string, opts: SeedOptions = {}): SeedResult {
  const p = requireInitialized(start);
  const from = opts.from ?? 'all';
  const limit = opts.limit ?? 5;
  const isDryRun = !!opts.dryRun;

  const existing = loadAll(p.recallDir).memories;
  const existingTitles = new Set(existing.map((m) => m.title.toLowerCase().trim()));

  const allCandidates: SeedCandidate[] = [];
  const sourcesUsed: string[] = [];

  if (from === 'all' || from === 'git') {
    const gitCands = extractGitCandidates(p.root);
    if (gitCands.length > 0) {
      allCandidates.push(...gitCands);
      sourcesUsed.push('git');
    }
  }

  if (from === 'all' || from === 'docs') {
    const docCands = extractDocsCandidates(p.root);
    if (docCands.length > 0) {
      allCandidates.push(...docCands);
      sourcesUsed.push('docs');
    }
  }

  // Deduplicate against existing memories and within candidates
  const uniqueCandidates: SeedCandidate[] = [];
  const seenTitles = new Set<string>();

  for (const cand of allCandidates) {
    const norm = cand.title.toLowerCase().trim();
    if (existingTitles.has(norm) || seenTitles.has(norm)) continue;
    seenTitles.add(norm);
    uniqueCandidates.push(cand);
    if (uniqueCandidates.length >= limit) break;
  }

  const proposed: Array<{ id?: string; title: string; type: string; source: string }> = [];

  for (const cand of uniqueCandidates) {
    if (isDryRun) {
      proposed.push({
        title: cand.title,
        type: cand.type,
        source: cand.source,
      });
    } else {
      const m = propose(p.root, {
        title: cand.title,
        text: cand.text,
        type: cand.type,
        tags: cand.tags,
        sources: [cand.source],
      });
      proposed.push({
        id: m.id,
        title: m.title,
        type: m.type,
        source: cand.source,
      });
    }
  }

  return {
    proposed,
    candidates: uniqueCandidates,
    dryRun: isDryRun,
    sourcesUsed,
  };
}
