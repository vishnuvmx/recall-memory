import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncAllAgentIntegrations } from './agent.js';
import { recordCheckpoint } from './checkpoint.js';
import { loadConfig } from './config.js';
import { isMemoryExpired } from './conflict.js';
import { gitHeadSha, hasGitDir, repoChanges } from './git.js';
import { formatHybridHitsCompact, hybridSearch } from './hybrid-retrieval.js';
import { rebuildIndex } from './index-builder.js';
import { readCachedLandmarks, syncLandmarksIncremental, type FileLandmarks } from './landmarks.js';
import { generateProjectMap } from './mapper.js';
import { computeRecallFilesStatKey, loadAll, loadSearchableMemories, type Memory } from './memory.js';
import { PASSPORT_BLOCK_NAME, computeManifestStatKey, loadFingerprint, saveFingerprint, syncPassport } from './passport.js';
import { findProject } from './project.js';
import { agentRemember } from './service.js';
import { computeMemoriesDigest, getSharedSqliteStore } from './sqlite-store.js';
import type { MemoryType, ProfileTier } from '../schemas/index.js';
import { detectPromptInjection } from '../security/poisoning.js';
import { findSecrets, redactSecrets } from '../security/secrets.js';
import { atomicWrite } from '../utils/fs.js';
import { extractManagedBlock } from '../utils/managed.js';

export interface ParsedChatTurn {
  conversationId?: string;
  model?: string;
  userPrompt: string;
  assistantReply: string;
}

export interface ExtractedInsight {
  title: string;
  text: string;
  type: MemoryType;
  tags: string[];
}

export interface SyncWorkspaceOptions {
  profile?: ProfileTier;
  force?: boolean;
  transcriptPath?: string;
  userPrompt?: string;
  assistantReply?: string;
  note?: string;
  model?: string;
  conversationId?: string;
  allAgents?: boolean;
}

export interface SyncWorkspaceReport {
  root: string;
  passportUpdated: boolean;
  mapUpdated: boolean;
  indexRebuilt: boolean;
  sqliteSynced: boolean;
  chatCheckpointRecorded: boolean;
  insightsSaved: Array<{ id: string; title: string; type: MemoryType; action: 'created' | 'updated' }>;
  agentsSynced?: string[];
}

function stripPromptWrappers(raw: string): string {
  let text = raw;
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
  if (reqMatch?.[1]) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function readTailUtf8(filePath: string, maxBytes = 98304): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    if (stat.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const offset = Math.max(0, stat.size - maxBytes);
      const bytes = fs.readSync(fd, buf, 0, maxBytes, offset);
      const slice = buf.toString('utf8', 0, bytes);
      const firstNewline = slice.indexOf('\n');
      return firstNewline >= 0 ? slice.slice(firstNewline + 1) : slice;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Parses the latest user prompt + assistant reply from local AI transcripts:
 * - Antigravity (`transcript.jsonl`: USER_INPUT / PLANNER_RESPONSE)
 * - Claude Code (`*.jsonl`: type="user" / type="assistant")
 * - Cursor / OpenAI / Ollama JSONL or JSON (`role: "user" | "assistant"`)
 * - Plain Markdown chat logs (`User:` / `Assistant:` or `## User` / `## Assistant`)
 */
export function parseTranscriptTail(transcriptPath: string): ParsedChatTurn | null {
  const raw = readTailUtf8(transcriptPath);
  if (!raw.trim()) return null;

  let lastUser = '';
  let lastAssistant = '';
  let detectedModel: string | undefined;

  const trimmed = raw.trim();

  // JSON array transcript
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
      for (const obj of arr) {
        const role = String(obj.role ?? obj.type ?? '').toLowerCase();
        const content = extractMessageContent(obj.content ?? (obj.message as Record<string, unknown> | undefined)?.content);
        if (role === 'user' && content.trim()) {
          lastUser = stripPromptWrappers(content);
          lastAssistant = '';
        } else if ((role === 'assistant' || role === 'model') && content.trim()) {
          lastAssistant = content.trim();
        }
      }
      if (lastUser || lastAssistant) {
        return { userPrompt: lastUser, assistantReply: lastAssistant, model: detectedModel };
      }
    } catch {
      // fall through to line-by-line parsing
    }
  }

  const lines = raw.split('\n');
  let parsedAnyJsonl = false;

  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith('{') || !l.endsWith('}')) continue;
    try {
      const obj = JSON.parse(l) as Record<string, unknown>;
      parsedAnyJsonl = true;

      if (typeof obj.model === 'string' && obj.model) detectedModel = obj.model;
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg && typeof msg.model === 'string' && msg.model) detectedModel = msg.model;

      // 1. Antigravity transcript.jsonl format
      const stepType = String(obj.type ?? '');
      const source = String(obj.source ?? '');
      if (stepType === 'USER_INPUT' || source === 'USER_EXPLICIT') {
        const c = extractMessageContent(obj.content);
        const clean = stripPromptWrappers(c);
        if (clean) {
          lastUser = clean;
          lastAssistant = '';
        }
        continue;
      }
      if (stepType === 'PLANNER_RESPONSE' || source === 'MODEL') {
        const c = extractMessageContent(obj.content).trim();
        if (c) lastAssistant = c;
        continue;
      }

      // 2. Claude Code / Cursor / Generic JSONL format
      const role = String(obj.role ?? msg?.role ?? obj.type ?? '').toLowerCase();
      const content = extractMessageContent(obj.content ?? msg?.content);
      if (role === 'user' && content.trim()) {
        const clean = stripPromptWrappers(content);
        // Skip tool_result synthetic user turns in Claude Code
        if (clean && !clean.startsWith('[{"type":"tool_result"')) {
          lastUser = clean;
          lastAssistant = '';
        }
      } else if ((role === 'assistant' || role === 'model') && content.trim()) {
        lastAssistant = content.trim();
      }
    } catch {
      continue;
    }
  }

  if (parsedAnyJsonl && (lastUser || lastAssistant)) {
    return { userPrompt: lastUser, assistantReply: lastAssistant, model: detectedModel };
  }

  // 3. Plain Markdown / text chat format
  const userMatches = [...raw.matchAll(/(?:^|\n)(?:##+\s*User|User|Human)\s*:?\s*\n?([\s\S]*?)(?=(?:\n(?:##+\s*(?:Assistant|Model|AI)|Assistant|Model|AI)\s*:?)|$)/gi)];
  const assistantMatches = [...raw.matchAll(/(?:^|\n)(?:##+\s*(?:Assistant|Model|AI)|Assistant|Model|AI)\s*:?\s*\n?([\s\S]*?)(?=(?:\n(?:##+\s*User|User|Human)\s*:?)|$)/gi)];
  if (userMatches.length > 0 || assistantMatches.length > 0) {
    lastUser = stripPromptWrappers(userMatches.at(-1)?.[1] ?? '');
    lastAssistant = (assistantMatches.at(-1)?.[1] ?? '').trim();
    if (lastUser || lastAssistant) {
      return { userPrompt: lastUser, assistantReply: lastAssistant };
    }
  }

  return null;
}

const LABELED_INSIGHT_PATTERNS: Array<{ re: RegExp; type: MemoryType; tag: string }> = [
  {
    re: /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:Architectural\s+Decision|Decision)\*{0,2}\s*:\s*([^\n]{20,300})/gi,
    type: 'decision',
    tag: 'chat-decision',
  },
  {
    re: /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:Architecture\s+Rule|Convention|Invariant|Project\s+Rule)\*{0,2}\s*:\s*([^\n]{20,300})/gi,
    type: 'convention',
    tag: 'chat-convention',
  },
  {
    re: /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:Root\s+Cause|Bugfix|Bug\s+Fix)\*{0,2}\s*:\s*([^\n]{20,300})/gi,
    type: 'bugfix',
    tag: 'chat-bugfix',
  },
  {
    re: /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:Failed\s+Approach|Dead\s+End)\*{0,2}\s*:\s*([^\n]{20,300})/gi,
    type: 'failed_approach',
    tag: 'chat-lesson',
  },
  {
    re: /(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}(?:Lesson\s+Learned|Key\s+Takeaway)\*{0,2}\s*:\s*([^\n]{20,300})/gi,
    type: 'lesson',
    tag: 'chat-lesson',
  },
];

function cleanInsightTitle(statement: string): string {
  const plain = statement
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clause = plain.split(/[.;:—–]/)[0]?.trim() ?? plain;
  return (clause.length >= 12 ? clause : plain).slice(0, 72).trim();
}

/**
 * Deterministically extracts explicit non-volatile decisions, conventions, bugfixes, and lessons
 * from normal chat turns without requiring any external LLM call.
 */
export function extractDurableInsights(userPrompt: string, assistantReply: string): ExtractedInsight[] {
  const insights: ExtractedInsight[] = [];
  const seen = new Set<string>();

  const pushCandidate = (rawStatement: string, type: MemoryType, tag: string): void => {
    const clean = rawStatement.replace(/\s+/g, ' ').trim();
    if (clean.length < 20 || clean.length > 350) return;
    if (clean.endsWith('?')) return;
    if (findSecrets(clean).length > 0) return;
    if (detectPromptInjection(clean).isPoisoned) return;

    const title = cleanInsightTitle(clean);
    const key = `${type}:${title.toLowerCase()}`;
    if (!title || seen.has(key)) return;
    seen.add(key);

    insights.push({
      title,
      text: clean,
      type,
      tags: [tag, 'auto-chat'],
    });
  };

  const combined = `${userPrompt}\n${assistantReply}`;
  for (const pat of LABELED_INSIGHT_PATTERNS) {
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(combined)) !== null) {
      if (m[1]) pushCandidate(m[1], pat.type, pat.tag);
      if (insights.length >= 4) return insights;
    }
  }

  // Also capture explicit durable engineering decisions phrased naturally ("We decided to ... because ...")
  const naturalPatterns: Array<{ re: RegExp; type: MemoryType; tag: string }> = [
    {
      re: /(?:^|[.!?\n]\s*)((?:We\s+decided\s+to|Architectural\s+invariant\s+is\s+to)\s+[^.!?\n]{20,220}\.)/gi,
      type: 'decision',
      tag: 'chat-decision',
    },
    {
      re: /(?:^|[.!?\n]\s*)((?:Never|Always)\s+(?:store|commit|mutate|bypass|use|run)\s+[^.!?\n]{18,200}\.)/gi,
      type: 'convention',
      tag: 'chat-convention',
    },
  ];

  for (const pat of naturalPatterns) {
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(combined)) !== null) {
      if (m[1]) pushCandidate(m[1], pat.type, pat.tag);
      if (insights.length >= 4) return insights;
    }
  }

  return insights;
}

export function extractWorkspaceFileReferences(root: string, text: string): string[] {
  if (!text) return [];
  const matches = text.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}\b|\b(?:package\.json|tsconfig\.json|Cargo\.toml|pyproject\.toml|go\.mod|AGENTS\.md|README\.md)\b/g) ?? [];
  const found: string[] = [];
  const seen = new Set<string>();

  for (const candidate of matches) {
    const rel = candidate.replace(/^\/+/, '');
    if (rel.startsWith('.recall/') || rel.startsWith('node_modules/') || seen.has(rel)) continue;
    try {
      const full = path.resolve(root, rel);
      if (!full.startsWith(path.resolve(root))) continue;
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        seen.add(rel);
        found.push(rel);
        if (found.length >= 10) break;
      }
    } catch {
      // ignore invalid path candidates
    }
  }
  return found;
}

function summarizeChatTurn(userPrompt: string, assistantReply: string, model?: string): string {
  const cleanUser = redactSecrets(stripPromptWrappers(userPrompt)).redacted
    .replace(/\s+/g, ' ')
    .trim();
  const cleanAssistant = redactSecrets(assistantReply).redacted
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim())
    .find((l) => l.length >= 16 && !l.startsWith('```') && !l.startsWith('>')) ?? '';

  const modelPrefix = model ? `[${model}] ` : '';
  const shortUser = cleanUser.length > 90 ? `${cleanUser.slice(0, 87)}...` : cleanUser;
  const shortReply = cleanAssistant.length > 95 ? `${cleanAssistant.slice(0, 92)}...` : cleanAssistant;

  if (shortUser && shortReply) {
    return `${modelPrefix}Chat: "${shortUser}" — ${shortReply}`;
  }
  if (shortUser) {
    return `${modelPrefix}Chat: "${shortUser}"`;
  }
  if (shortReply) {
    return `${modelPrefix}Chat response: ${shortReply}`;
  }
  return '';
}

function humanizeModelName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'auto') return undefined;
  return trimmed.slice(0, 48);
}

/**
 * Incremental workspace & chat synchronization engine.
 * - Stages passively extracted chat insights safely as `proposed` (never auto-promoting uncertain chat text into active rules).
 * - Preserves task context non-destructively: idle Q&A turns with 0 modified and 0 referenced files skip overwriting CURRENT_STATE.md.
 * - Stops regenerating PROJECT_MAP.md on every turn (only regenerated when `opts.force` is true).
 * - Skips redundant repo walks and memory Markdown disk reads when stat fingerprints match.
 */
export function syncWorkspace(start: string, opts: SyncWorkspaceOptions = {}): SyncWorkspaceReport {
  const p = findProject(start);
  if (!p.initialized) {
    return {
      root: p.root,
      passportUpdated: false,
      mapUpdated: false,
      indexRebuilt: false,
      sqliteSynced: false,
      chatCheckpointRecorded: false,
      insightsSaved: [],
    };
  }

  const { root, recallDir } = p;
  let profile: ProfileTier = opts.profile ?? 'standard';
  if (!opts.profile) {
    try {
      profile = loadConfig(recallDir).profile ?? 'standard';
    } catch {
      profile = 'standard';
    }
  }

  let userPrompt = opts.userPrompt ? stripPromptWrappers(opts.userPrompt) : '';
  let assistantReply = opts.assistantReply?.trim() ?? '';
  let detectedModel = humanizeModelName(opts.model);

  if (opts.transcriptPath) {
    const parsed = parseTranscriptTail(opts.transcriptPath);
    if (parsed) {
      if (!userPrompt && parsed.userPrompt) userPrompt = parsed.userPrompt;
      if (!assistantReply && parsed.assistantReply) assistantReply = parsed.assistantReply;
      if (!detectedModel && parsed.model) detectedModel = humanizeModelName(parsed.model);
    }
  }

  if (opts.note?.trim()) {
    const noteClean = opts.note.trim();
    userPrompt = userPrompt ? `${userPrompt}\n${noteClean}` : noteClean;
  }

  const insightsSaved: SyncWorkspaceReport['insightsSaved'] = [];

  // 1. Extract explicit durable candidates from chat turn locally — ALWAYS staged as `proposed`
  //    so uncertain regex matches never silently promote into active memory or PASSPORT.md.
  if (userPrompt || assistantReply) {
    const insights = extractDurableInsights(userPrompt, assistantReply);
    for (const item of insights) {
      try {
        const res = agentRemember(root, {
          title: item.title,
          text: item.text,
          type: item.type,
          tags: item.tags,
          sources: ['local-chat-sync'],
          status: 'proposed',
          confidence: 0.65,
        });
        insightsSaved.push({
          id: res.memory.id,
          title: res.memory.title,
          type: res.memory.type,
          action: res.action,
        });
      } catch {
        // Never fail sync if an extracted insight hits a validation guard
      }
    }
  }

  // 2. Non-destructive task state update:
  //    Only update CURRENT_STATE.md when real workspace files were modified or referenced (or explicit note).
  //    Idle Q&A turns with 0 modified and 0 referenced files perform 0 destructive overwrites!
  let chatCheckpointRecorded = false;
  const fpBefore = loadFingerprint(recallDir);
  const isGitRepo = hasGitDir(root);
  const modifiedFiles = isGitRepo ? (repoChanges(root) ?? []).slice(0, 20) : [];
  const referencedFiles =
    userPrompt || assistantReply
      ? extractWorkspaceFileReferences(root, `${userPrompt}\n${assistantReply}`)
      : [];

  let nextChatTurnHash = fpBefore.lastChatTurnHash;
  let nextConversationId = fpBefore.lastConversationId;

  if (modifiedFiles.length > 0 || referencedFiles.length > 0 || Boolean(opts.note?.trim())) {
    const turnDigest = crypto
      .createHash('sha256')
      .update(
        `${opts.conversationId ?? ''}\0${modifiedFiles.join(',')}\0${referencedFiles.join(',')}\0${userPrompt}\0${assistantReply.slice(0, 400)}`,
      )
      .digest('hex');

    if (fpBefore.lastChatTurnHash !== turnDigest) {
      const chatSummary =
        userPrompt || assistantReply
          ? summarizeChatTurn(userPrompt, assistantReply, detectedModel)
          : undefined;
      if (chatSummary || modifiedFiles.length > 0) {
        const cp = recordCheckpoint(root, recallDir, chatSummary, {
          auto: true,
          model: detectedModel,
          referencedFiles,
          precomputedModifiedFiles: modifiedFiles,
          conversationId: opts.conversationId,
        });
        chatCheckpointRecorded = !cp.skipped;
        nextChatTurnHash = turnDigest;
        if (opts.conversationId) nextConversationId = opts.conversationId;
      }
    }
  }

  // 3. Memory store, INDEX.md, and SQLite sync — skipped completely when .recall/ file stats are unchanged!
  const currentMemStatKey = computeRecallFilesStatKey(recallDir);
  const memoriesChanged =
    Boolean(opts.force) ||
    insightsSaved.length > 0 ||
    fpBefore.memoriesStatKey !== currentMemStatKey ||
    !fs.existsSync(path.join(recallDir, 'INDEX.md'));

  let indexRebuilt = false;
  let sqliteSynced = false;
  let searchable: Memory[] | undefined;
  let nextMemoriesHash = fpBefore.memoriesHash;

  if (memoriesChanged) {
    const loaded = loadAll(recallDir);
    rebuildIndex(recallDir, loaded);
    indexRebuilt = true;

    searchable = loadSearchableMemories(recallDir, loaded);
    nextMemoriesHash = computeMemoriesDigest(searchable);
    try {
      sqliteSynced = getSharedSqliteStore(recallDir).ensureSynced(searchable, currentMemStatKey);
    } catch {
      // Fallback cleanly when node:sqlite is unavailable (e.g., Node 20.x)
    }
  }

  // 4. Single-pass incremental code symbol index update:
  //    - Clean Git repo with unchanged HEAD & valid v3 cache -> 0 directory walks, 0 stats!
  //    - Dirty Git repo with unchanged HEAD & valid v3 cache -> update ONLY the modified files (0 directory walks)!
  //    - Non-git repo or cold cache -> 1 single incremental pass (down from 4 walks!).
  const currentGitHead = isGitRepo ? (gitHeadSha(root) ?? undefined) : undefined;
  const cachedCodeFiles = !opts.force ? readCachedLandmarks(recallDir, 1, Number.POSITIVE_INFINITY, 16) : null;

  let exportedSurfaceChanged = false;
  let preloadedCodeFiles: FileLandmarks[] | undefined;

  if (isGitRepo && cachedCodeFiles && currentGitHead && fpBefore.gitHead === currentGitHead && !opts.force) {
    if (modifiedFiles.length === 0) {
      // Zero code changes in clean git workspace!
      preloadedCodeFiles = cachedCodeFiles;
      exportedSurfaceChanged = false;
    } else {
      const inc = syncLandmarksIncremental(root, recallDir, {
        changedFiles: modifiedFiles,
        minLines: 1,
        maxFiles: Number.POSITIVE_INFINITY,
        maxSymbols: 16,
      });
      preloadedCodeFiles = inc.files;
      exportedSurfaceChanged = inc.exportedSurfaceChanged;
    }
  } else {
    const inc = syncLandmarksIncremental(root, recallDir, {
      minLines: 1,
      maxFiles: Number.POSITIVE_INFINITY,
      maxSymbols: 16,
    });
    preloadedCodeFiles = inc.files;
    exportedSurfaceChanged = inc.exportedSurfaceChanged;
  }

  // 5. Incrementally sync non-volatile PASSPORT.md ONLY when exports, manifests, or memories changed
  const currentManifestStatKey = computeManifestStatKey(root);
  const passportFile = path.join(recallDir, 'PASSPORT.md');
  const needsPassportCheck =
    Boolean(opts.force) ||
    exportedSurfaceChanged ||
    memoriesChanged ||
    fpBefore.manifestStatKey !== currentManifestStatKey ||
    !fs.existsSync(passportFile);

  let passportUpdated = false;
  let nextPassportHash = fpBefore.passportHash;

  if (needsPassportCheck) {
    const passMemories = searchable ?? loadSearchableMemories(recallDir);
    const passportRes = syncPassport(root, recallDir, {
      profile,
      force: opts.force,
      memories: passMemories,
      preloadedFiles: preloadedCodeFiles,
    });
    passportUpdated = passportRes.updated;
    nextPassportHash = passportRes.passportHash;
    nextMemoriesHash = computeMemoriesDigest(passMemories);
  }

  // 6. Do NOT regenerate PROJECT_MAP.md on every turn (only when `opts.force` is explicitly requested)
  let mapUpdated = false;
  if (opts.force) {
    generateProjectMap(root, recallDir, profile, preloadedCodeFiles);
    mapUpdated = true;
  }

  // 7. Persist fingerprint ONLY when at least one tracked key changed (0 disk writes on unchanged idle turns!)
  const fpChanged =
    fpBefore.passportHash !== nextPassportHash ||
    fpBefore.memoriesHash !== nextMemoriesHash ||
    fpBefore.memoriesStatKey !== currentMemStatKey ||
    fpBefore.manifestStatKey !== currentManifestStatKey ||
    fpBefore.gitHead !== currentGitHead ||
    fpBefore.lastChatTurnHash !== nextChatTurnHash ||
    fpBefore.lastConversationId !== nextConversationId;

  if (fpChanged) {
    saveFingerprint(recallDir, {
      ...fpBefore,
      passportHash: nextPassportHash,
      memoriesHash: nextMemoriesHash,
      memoriesStatKey: currentMemStatKey,
      manifestStatKey: currentManifestStatKey,
      gitHead: currentGitHead,
      lastChatTurnHash: nextChatTurnHash,
      lastConversationId: nextConversationId,
    });
  }

  // 8. Optional multi-agent instruction & hook synchronization
  let agentsSynced: string[] | undefined;
  if (opts.allAgents) {
    agentsSynced = syncAllAgentIntegrations(root, { createMissing: true });
  }

  return {
    root,
    passportUpdated,
    mapUpdated,
    indexRebuilt,
    sqliteSynced,
    chatCheckpointRecorded,
    insightsSaved,
    ...(agentsSynced ? { agentsSynced } : {}),
  };
}

export async function readStdinNonBlocking(timeoutMs = 150): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const maxBytes = 262144;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onEnd);
      try {
        process.stdin.pause();
      } catch {
        // ignore
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer | string): void => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (total < maxBytes) {
        chunks.push(b.subarray(0, maxBytes - total));
        total += b.length;
      }
      if (total >= maxBytes) finish();
    };

    const onEnd = (): void => finish();

    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
    try {
      process.stdin.resume();
    } catch {
      finish();
    }
  });
}

export interface HookPayload {
  // Antigravity fields (camelCase protojson contract)
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  hookEventName?: string;
  terminationReason?: string;
  executionNum?: number;
  fullyIdle?: boolean;
  continuationActive?: boolean;

  // Claude Code / Cursor / Windsurf fields (snake_case contract)
  session_id?: string;
  conversation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  model?: string;
  prompt?: string;
  response?: string;
}

export interface InjectionOptions {
  query?: string;
  maxTokens?: number;
  maxChars?: number;
}

function summarizeUnsyncedMemories(memories: Memory[], existingPassportText: string): string[] {
  const lowerPassport = existingPassportText.toLowerCase();
  const lines: string[] = [];

  for (const m of memories) {
    if (m.id.startsWith('doc_')) {
      for (const rawLine of m.body.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        const match = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(trimmed);
        if (!match?.[1]) continue;
        const bullet = match[1].trim();
        if (!bullet || bullet.startsWith('(Add ') || bullet.includes('[INDEX.md]')) continue;
        if (detectPromptInjection(bullet).isPoisoned || findSecrets(bullet).length > 0) continue;
        const snippet = bullet.slice(0, 48).toLowerCase();
        if (!lowerPassport.includes(snippet)) {
          lines.push(`- ${bullet.length > 160 ? `${bullet.slice(0, 157)}...` : bullet}`);
        }
      }
      continue;
    }

    if (existingPassportText.includes(`(${m.id})`) || lowerPassport.includes(m.title.trim().toLowerCase())) {
      continue;
    }
    const firstBodyLine =
      m.body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('---')) ?? '';
    const cleanBody = firstBodyLine.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
    const shortBody = cleanBody.length > 140 ? `${cleanBody.slice(0, 137)}...` : cleanBody;
    const summary =
      shortBody && shortBody.toLowerCase() !== m.title.toLowerCase()
        ? `- **[${m.type}] ${m.title}**: ${shortBody} _(${m.id})_`
        : `- **[${m.type}] ${m.title}** _(${m.id})_`;
    if (!detectPromptInjection(summary).isPoisoned && findSecrets(summary).length === 0) {
      lines.push(summary);
    }
  }

  return lines.slice(0, 10);
}

/**
 * Deterministic, read-only, sanitized context builder for `SessionStart` and `UserPromptSubmit` hooks.
 * - NEVER injects memories with `proposed`, `superseded`, or `archived` status.
 * - NEVER injects memories or passport lines that fail prompt injection (`detectPromptInjection`) or secret checks (`findSecrets`).
 * - NEVER rewrites tracked project files (`.recall/PASSPORT.md`, `INDEX.md`, `CURRENT_STATE.md`), keeping `SessionStart` fast and side-effect-free.
 */
export function buildSanitizedInjectionContext(start: string, opts: InjectionOptions = {}): string {
  const p = findProject(start);
  if (!p.initialized) return '';

  const { recallDir } = p;
  const maxTokens = opts.maxTokens ?? 550;
  const maxChars = opts.maxChars ?? 2200;
  const effectiveMaxChars = Math.min(maxChars, maxTokens * 4);
  const queryClean = opts.query ? stripPromptWrappers(opts.query).trim() : '';

  const passportPath = path.join(recallDir, 'PASSPORT.md');
  const currentStatePath = path.join(recallDir, 'CURRENT_STATE.md');
  let passportStatKey = 'missing';
  try {
    const pStat = fs.existsSync(passportPath) ? fs.statSync(passportPath) : undefined;
    const csStat = fs.existsSync(currentStatePath) ? fs.statSync(currentStatePath) : undefined;
    const filesKey = computeRecallFilesStatKey(recallDir);
    passportStatKey = `${pStat ? `${pStat.size}:${Math.floor(pStat.mtimeMs)}` : 'no-p'}|${csStat ? `${csStat.size}:${Math.floor(csStat.mtimeMs)}` : 'no-cs'}|${filesKey}`;
  } catch {
    passportStatKey = 'err';
  }

  const fp = loadFingerprint(recallDir);
  const cachePath = path.join(recallDir, '.cache', 'injection-cache.json');

  // Fast-path cache check before reading/parsing all Markdown files on SessionStart
  if (fp.memoriesHash) {
    const fastKey = crypto
      .createHash('sha256')
      .update(`v1\0${passportStatKey}\0${fp.memoriesHash}\0${queryClean.toLowerCase()}\0${effectiveMaxChars}`)
      .digest('hex');
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { fastKey?: string; context?: string };
        if (cached.fastKey === fastKey && typeof cached.context === 'string') {
          return cached.context;
        }
      }
    } catch {
      // ignore corrupt cache
    }
  }

  const allMemories = loadSearchableMemories(recallDir);
  // Strict security gate: only active, non-expired, non-deprecated memories that pass poisoning & secret checks
  const safeActiveMemories: Memory[] = [];
  const unsafeTitles = new Set<string>();

  for (const m of allMemories) {
    if (m.status !== 'active' || m.deprecated || isMemoryExpired(m)) {
      unsafeTitles.add(m.title.trim().toLowerCase());
      continue;
    }
    const combined = `${m.title}\n${m.body}`;
    if (detectPromptInjection(combined).isPoisoned || findSecrets(combined).length > 0) {
      unsafeTitles.add(m.title.trim().toLowerCase());
      continue;
    }
    safeActiveMemories.push(m);
  }

  const safeDigest = computeMemoriesDigest(safeActiveMemories);
  const cacheKey = crypto
    .createHash('sha256')
    .update(`v1\0${passportStatKey}\0${safeDigest}\0${queryClean.toLowerCase()}\0${effectiveMaxChars}`)
    .digest('hex');
  const fastKey = fp.memoriesHash
    ? crypto
        .createHash('sha256')
        .update(`v1\0${passportStatKey}\0${fp.memoriesHash}\0${queryClean.toLowerCase()}\0${effectiveMaxChars}`)
        .digest('hex')
    : undefined;

  try {
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { key?: string; context?: string };
      if (cached.key === cacheKey && typeof cached.context === 'string') {
        return cached.context;
      }
    }
  } catch {
    // ignore corrupt cache
  }

  const sections: string[] = [];
  let cleanedPassport = '';

  // 1. Read existing PASSPORT.md without triggering cold regeneration, sanitizing each line
  if (fs.existsSync(passportPath)) {
    try {
      const rawPassport = fs.readFileSync(passportPath, 'utf8');
      const block = extractManagedBlock(rawPassport, PASSPORT_BLOCK_NAME) ?? rawPassport.trim();
      const safeLines = block.split('\n').filter((line) => {
        if (!line.trim()) return true;
        if (detectPromptInjection(line).isPoisoned || findSecrets(line).length > 0) return false;
        const lower = line.toLowerCase();
        for (const badTitle of unsafeTitles) {
          if (badTitle.length >= 6 && lower.includes(badTitle)) return false;
        }
        return true;
      });
      cleanedPassport = safeLines.join('\n').trim();
      if (cleanedPassport) {
        sections.push(cleanedPassport);
      }
    } catch {
      // ignore unreadable passport
    }
  }

  // 1a. Include any active rules/memories that were added or hand-edited without running manual CLI rebuilds
  if (cleanedPassport && safeActiveMemories.length > 0) {
    const unsyncedLines = summarizeUnsyncedMemories(safeActiveMemories, cleanedPassport);
    if (unsyncedLines.length > 0) {
      sections.push('', '## Active Project Rules & Memories', ...unsyncedLines);
    }
  }

  // 1b. Append sanitized Active Working Files & Symbol Map from CURRENT_STATE.md if present
  if (fs.existsSync(currentStatePath)) {
    try {
      const rawCs = fs.readFileSync(currentStatePath, 'utf8');
      const marker = '## Active Working Files & Symbol Map (Skip File Discovery)';
      const idx = rawCs.indexOf(marker);
      if (idx !== -1) {
        const after = rawCs.slice(idx + marker.length).split(/\r?\n/);
        const mapLines: string[] = [];
        for (const line of after) {
          const trimmed = line.trim();
          if (trimmed.startsWith('## ')) break;
          if (!trimmed.startsWith('- `')) continue;
          if (detectPromptInjection(trimmed).isPoisoned || findSecrets(trimmed).length > 0) continue;
          mapLines.push(trimmed);
        }
        if (mapLines.length > 0) {
          sections.push('', marker, ...mapLines);
        }
      }
    } catch {
      // ignore unreadable current state
    }
  }

  // 2. If a prompt query is provided (e.g. SessionStart lastUserInput or UserPromptSubmit), append top sanitized hybrid matches
  if (queryClean && safeActiveMemories.length > 0) {
    let store;
    try {
      store = getSharedSqliteStore(recallDir);
      store.ensureSynced(safeActiveMemories);
    } catch {
      store = undefined;
    }
    const hits = hybridSearch(safeActiveMemories, queryClean, {
      limit: 4,
      includeProposed: false,
      includeArchived: false,
      includeSuperseded: false,
      sqliteStore: store,
    });
    if (hits.length > 0) {
      sections.push('', `## Relevant Active Memory`, formatHybridHitsCompact(hits, 600, 150));
    }
  } else if (sections.length === 0 && safeActiveMemories.length > 0) {
    // Fallback if PASSPORT.md was missing: deterministic list of active decisions/conventions
    const lines = ['# Project Memory (Sanitized Active Rules)'];
    for (const m of safeActiveMemories.slice(0, 8)) {
      lines.push(`- **[${m.type}] ${m.title}** (\`.recall/${m.file}\`)`);
    }
    sections.push(lines.join('\n'));
  }

  let output = sections.join('\n').trim();
  if (output.length > effectiveMaxChars) {
    const cut = output.slice(0, effectiveMaxChars - 40);
    const lastNl = cut.lastIndexOf('\n');
    output = `${cut.slice(0, lastNl > 0 ? lastNl : cut.length)}\n...[capped]`;
  }

  // Final safety gate on assembled output
  if (detectPromptInjection(output).isPoisoned) {
    output = detectPromptInjection(output).neutralizedText;
  }
  output = redactSecrets(output).redacted;

  try {
    atomicWrite(cachePath, `${JSON.stringify({ key: cacheKey, fastKey, context: output }, null, 2)}\n`);
  } catch {
    // non-fatal if cache write fails
  }

  return output;
}

/**
 * Universal lifecycle hook handler for Antigravity, Claude Code, Cursor, Windsurf, and CLI pipes.
 * Never throws; always returns valid hook JSON for the calling agent runtime.
 */
export function processLifecycleHookInput(rawStdin: string, fallbackCwd = process.cwd()): string {
  const trimmed = typeof rawStdin === 'string' ? rawStdin.trim() : '';
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return '{}';
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(trimmed);
  } catch {
    return '{}';
  }
  if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
    return '{}';
  }

  const payload = parsedUnknown as HookPayload;

  const wsPath =
    Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0].trim()
      ? payload.workspacePaths[0]
      : undefined;
  const wsRoot =
    Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === 'string' && payload.workspace_roots[0].trim()
      ? payload.workspace_roots[0]
      : undefined;
  const cwdPath = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : undefined;
  const startDir = wsPath || wsRoot || cwdPath || fallbackCwd;

  const agyEventName = typeof payload.hookEventName === 'string' ? payload.hookEventName.trim() : '';
  const claudeEventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name.trim() : '';
  const eventName = agyEventName || claudeEventName;

  const isAntigravity =
    Boolean(agyEventName) ||
    (!claudeEventName &&
      (Array.isArray(payload.workspacePaths) ||
        typeof payload.conversationId === 'string' ||
        typeof payload.artifactDirectoryPath === 'string' ||
        typeof payload.terminationReason === 'string' ||
        typeof payload.executionNum === 'number'));

  if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit' || eventName === 'PreInvocation') {
    try {
      const query =
        typeof payload.prompt === 'string' && payload.prompt.trim()
          ? payload.prompt
          : typeof payload.lastUserInput === 'string' && payload.lastUserInput.trim()
            ? payload.lastUserInput
            : undefined;
      const additionalContext = buildSanitizedInjectionContext(startDir, { query });
      if (!additionalContext) return '{}';

      if (isAntigravity && (eventName === 'SessionStart' || eventName === 'PreInvocation')) {
        return JSON.stringify({
          injectSteps: [
            {
              systemMessage: {
                systemMessage: additionalContext,
              },
            },
          ],
        });
      }

      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext,
        },
      });
    } catch {
      return '{}';
    }
  }

  const isAntigravityStop =
    (isAntigravity && eventName === 'Stop') ||
    typeof payload.terminationReason === 'string' ||
    typeof payload.executionNum === 'number';

  const hasSyncableSignal =
    eventName === 'Stop' ||
    isAntigravityStop ||
    typeof payload.transcriptPath === 'string' ||
    typeof payload.transcript_path === 'string' ||
    typeof payload.lastUserInput === 'string' ||
    typeof payload.prompt === 'string' ||
    typeof payload.response === 'string';

  if (!hasSyncableSignal) {
    return '{}';
  }

  try {
    syncWorkspace(startDir, {
      transcriptPath:
        (typeof payload.transcriptPath === 'string' ? payload.transcriptPath : undefined) ||
        (typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined),
      userPrompt:
        (typeof payload.lastUserInput === 'string' ? payload.lastUserInput : undefined) ||
        (typeof payload.prompt === 'string' ? payload.prompt : undefined),
      assistantReply: typeof payload.response === 'string' ? payload.response : undefined,
      model:
        (typeof payload.modelName === 'string' ? payload.modelName : undefined) ||
        (typeof payload.model === 'string' ? payload.model : undefined),
      conversationId:
        (typeof payload.conversationId === 'string' ? payload.conversationId : undefined) ||
        (typeof payload.session_id === 'string' ? payload.session_id : undefined) ||
        (typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined),
    });
  } catch {
    // Bookkeeping must never break an AI agent's execution loop
  }

  if (isAntigravityStop) {
    return JSON.stringify({ decision: 'stop' });
  }
  return '{}';
}

export async function runLifecycleHook(fallbackCwd = process.cwd()): Promise<string> {
  const raw = await readStdinNonBlocking();
  return processLifecycleHookInput(raw, fallbackCwd);
}

