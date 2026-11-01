import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { syncAllAgentIntegrations } from './agent.js';
import { recordCheckpoint } from './checkpoint.js';
import { loadConfig } from './config.js';
import { repoChanges } from './git.js';
import { indexState, rebuildIndex } from './index-builder.js';
import { DEFAULT_IGNORED_DIRS, TEST_FILE_REGEX, createGitignoreFilter, generateProjectMap } from './mapper.js';
import { loadSearchableMemories } from './memory.js';
import { loadFingerprint, saveFingerprint, syncPassport } from './passport.js';
import { findProject } from './project.js';
import { agentRemember } from './service.js';
import { computeMemoriesDigest, getSharedSqliteStore } from './sqlite-store.js';
import type { MemoryType, ProfileTier } from '../schemas/index.js';
import { detectPromptInjection } from '../security/poisoning.js';
import { findSecrets, redactSecrets } from '../security/secrets.js';
import { toPosix } from '../utils/fs.js';

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

function computeCodeTreeDigest(root: string): string {
  const isGitignored = createGitignoreFilter(root);
  const h = crypto.createHash('sha256');

  function walk(currentDir: string, depth: number): void {
    if (depth > 5) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(currentDir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isGitignored(rel, true)) continue;
        h.update(`D:${rel}\n`);
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (isGitignored(rel, false) || TEST_FILE_REGEX.test(entry.name)) continue;
        try {
          const st = fs.statSync(full);
          h.update(`F:${rel}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
        } catch {
          // ignore
        }
      }
    }
  }

  walk(root, 0);
  return h.digest('hex');
}

function humanizeModelName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'auto') return undefined;
  return trimmed.slice(0, 48);
}

/**
 * Incremental workspace & chat synchronization engine.
 * - Updates chat session state and durable memories even on normal clean-git chats.
 * - Skips cold-run re-analysis when file & memory hashes in `.recall/.cache/fingerprint.json` match.
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

  // 1. Extract explicit non-volatile decisions/conventions/bugfixes from chat turn locally
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

  // 2. Record normal chat turn or git checkpoint (deduplicated via turnHash)
  let chatCheckpointRecorded = false;
  const fpBefore = loadFingerprint(recallDir);
  const modifiedFiles = (repoChanges(root) ?? []).slice(0, 20);

  if (userPrompt || assistantReply) {
    const turnDigest = crypto
      .createHash('sha256')
      .update(`${opts.conversationId ?? ''}\0${userPrompt}\0${assistantReply.slice(0, 400)}\0${modifiedFiles.join(',')}`)
      .digest('hex');

    if (fpBefore.lastChatTurnHash !== turnDigest) {
      const chatSummary = summarizeChatTurn(userPrompt, assistantReply, detectedModel);
      const referencedFiles = extractWorkspaceFileReferences(root, `${userPrompt}\n${assistantReply}`);
      if (chatSummary) {
        const cp = recordCheckpoint(root, recallDir, chatSummary, {
          auto: true,
          model: detectedModel,
          referencedFiles,
        });
        chatCheckpointRecorded = !cp.skipped;
        fpBefore.lastChatTurnHash = turnDigest;
        if (opts.conversationId) fpBefore.lastConversationId = opts.conversationId;
        saveFingerprint(recallDir, fpBefore);
      }
    }
  } else if (modifiedFiles.length > 0) {
    const cp = recordCheckpoint(root, recallDir, undefined, { auto: true, model: detectedModel });
    chatCheckpointRecorded = !cp.skipped;
  }

  // 3. Rebuild INDEX.md only when stale or missing
  let indexRebuilt = false;
  if (opts.force || indexState(recallDir) !== 'up_to_date') {
    rebuildIndex(recallDir);
    indexRebuilt = true;
  }

  // 4. Sync SQLite FTS5 & dense vector embeddings incrementally
  let sqliteSynced = false;
  const searchable = loadSearchableMemories(recallDir);
  try {
    sqliteSynced = getSharedSqliteStore(recallDir).ensureSynced(searchable);
  } catch {
    // Fallback cleanly when node:sqlite is unavailable (e.g., Node 20.x)
  }

  // 5. Incrementally sync non-volatile PASSPORT.md (0 re-analysis if structural + memory hash matches)
  const passportRes = syncPassport(root, recallDir, { profile, force: opts.force });

  // 6. Incrementally sync PROJECT_MAP.md only when code tree mtimes/sizes changed
  const fpAfter = loadFingerprint(recallDir);
  const currentMapHash = `${profile}:${computeCodeTreeDigest(root)}`;
  const mapFile = path.join(recallDir, 'PROJECT_MAP.md');
  let mapUpdated = false;
  if (opts.force || fpAfter.mapHash !== currentMapHash || !fs.existsSync(mapFile)) {
    generateProjectMap(root, recallDir, profile);
    mapUpdated = true;
  }

  saveFingerprint(recallDir, {
    ...fpAfter,
    passportHash: passportRes.passportHash,
    mapHash: currentMapHash,
    memoriesHash: computeMemoriesDigest(searchable),
    lastChatTurnHash: fpBefore.lastChatTurnHash ?? fpAfter.lastChatTurnHash,
    lastConversationId: fpBefore.lastConversationId ?? fpAfter.lastConversationId,
  });

  // 7. Optional multi-agent instruction & hook synchronization
  let agentsSynced: string[] | undefined;
  if (opts.allAgents) {
    agentsSynced = syncAllAgentIntegrations(root, { createMissing: true });
  }

  return {
    root,
    passportUpdated: passportRes.updated,
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
  // Antigravity fields
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  modelName?: string;
  lastUserInput?: string;
  terminationReason?: string;
  executionNum?: number;

  // Claude Code / Cursor / Windsurf fields
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

/**
 * Universal lifecycle hook handler for Antigravity, Claude Code, Cursor, Windsurf, and CLI pipes.
 * Never throws; always returns valid hook JSON for the calling agent runtime.
 */
export function processLifecycleHookInput(rawStdin: string, fallbackCwd = process.cwd()): string {
  let payload: HookPayload = {};
  let plainNote = '';
  const trimmed = rawStdin.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      payload = JSON.parse(trimmed) as HookPayload;
    } catch {
      plainNote = trimmed;
    }
  } else if (trimmed) {
    plainNote = trimmed;
  }

  const isAntigravityStop =
    typeof payload.terminationReason === 'string' || typeof payload.executionNum === 'number';

  const startDir =
    payload.workspacePaths?.[0] ||
    payload.workspace_roots?.[0] ||
    payload.cwd ||
    fallbackCwd;

  try {
    syncWorkspace(startDir, {
      transcriptPath: payload.transcriptPath || payload.transcript_path,
      userPrompt: payload.lastUserInput || payload.prompt,
      assistantReply: payload.response,
      note: plainNote || undefined,
      model: payload.modelName || payload.model,
      conversationId: payload.conversationId || payload.session_id || payload.conversation_id,
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

