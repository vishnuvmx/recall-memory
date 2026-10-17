import readline from 'node:readline';
import { checkpoint, context, map, propose, status } from '../core/service.js';
import { MEMORY_TYPES, type MemoryType } from '../schemas/index.js';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no SDK dependency.
 * Exposes read/context access, proposed memory submissions, checkpoints, status, and map updates.
 */
const TOOLS = [
  {
    name: 'recall_context',
    description: 'Keyword-search the project memory (active memories only). Not semantic search.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'recall_propose',
    description: 'Propose a new memory. It is saved as "proposed" and needs human approval (`recall approve <id>`).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'recall_checkpoint',
    description: 'Record an iteration snapshot into .recall/CURRENT_STATE.md and session-log.md (rolling 14-day history).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '1-sentence summary of what was accomplished (optional; auto-detected if omitted)' },
        nextSteps: { type: 'string', description: 'Immediate next steps (only if multi-step plan is partially done)' },
      },
    },
  },
  {
    name: 'recall_map',
    description: 'Regenerate .recall/PROJECT_MAP.md with latest repository topology and line landmarks.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'recall_status',
    description: 'Get project memory status: count of active/proposed records, index health, and uncommitted memory changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

type Json = Record<string, unknown>;

function callTool(cwd: string, name: string, args: Json): string {
  if (name === 'recall_context') {
    const hits = context(cwd, String(args.query ?? ''), { limit: Number(args.limit) || 5 });
    if (hits.length === 0) return 'No relevant memory found.';
    return hits
      .map((h) => `${h.memory.title} [${h.memory.type}, ${h.memory.status}, ${h.memory.verification}]\n${h.memory.file}\n${h.excerpt}`)
      .join('\n\n');
  }
  if (name === 'recall_propose') {
    const type = MEMORY_TYPES.includes(args.type as MemoryType) ? (args.type as MemoryType) : 'fact';
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const m = propose(cwd, { title: String(args.title ?? ''), text: String(args.text ?? ''), type, tags });
    return `Proposed ${m.id} at ${m.file}. A human must run \`recall approve ${m.id}\`.`;
  }
  if (name === 'recall_checkpoint') {
    const summary = args.summary ? String(args.summary) : undefined;
    const nextSteps = args.nextSteps ? String(args.nextSteps) : undefined;
    const res = checkpoint(cwd, summary, { nextSteps, auto: !args.summary });
    return `Checkpoint recorded [${res.timestamp}]: ${res.summary}${res.nextSteps ? ` (Next: ${res.nextSteps})` : ''}\nModified files: ${res.modifiedFiles.length > 0 ? res.modifiedFiles.join(', ') : 'clean'}`;
  }
  if (name === 'recall_map') {
    const file = map(cwd);
    return `Project map refreshed at ${file}.`;
  }
  if (name === 'recall_status') {
    const s = status(cwd);
    const types = Object.entries(s.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    const statuses = Object.entries(s.byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    return `Recall Status:\n- Types: ${types}\n- Statuses: ${statuses}\n- Index: ${s.index}\n- Problems: ${s.problems}\n- Git changes in .recall: ${s.git.changes?.length ?? 0}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function handleMessage(cwd: string, msg: Json): Json | null {
  const id = msg.id as string | number | undefined;
  const reply = (result: unknown): Json => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // notifications need no response
  switch (msg.method) {
    case 'initialize': {
      const params = (msg.params ?? {}) as Json;
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'recall', version: '0.1.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const p = (msg.params ?? {}) as Json;
      try {
        const text = callTool(cwd, String(p.name), (p.arguments ?? {}) as Json);
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`);
  }
}

export function serveStdio(cwd: string): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let out: Json | null;
    try {
      out = handleMessage(cwd, JSON.parse(line) as Json);
    } catch {
      out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
