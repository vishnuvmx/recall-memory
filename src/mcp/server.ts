import readline from 'node:readline';
import { agentRemember, checkpoint, context, map, propose, status, whereIs } from '../core/service.js';
import { formatHitsCompact } from '../core/retrieval.js';
import { formatWhere } from '../core/where.js';
import { MEMORY_TYPES, type MemoryType } from '../schemas/index.js';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no SDK dependency.
 *
 * TOKEN BUDGET: every listed tool schema is sent to the model on every turn, so the list is kept to
 * three terse tools (enforced by tests/budget.test.ts). Bookkeeping (checkpoints, map refresh, status)
 * is NOT exposed to the model; those run from hooks/CLI. Legacy tool names stay callable, unlisted.
 */
export const TOOLS = [
  {
    name: 'recall_context',
    description: 'Search project memory (decisions, conventions, lessons). Capped output.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'recall_where',
    description: 'Find a symbol or file: returns file:line rows.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'recall_remember',
    description: 'Save a non-obvious decision, convention, or lesson. Similar titles update in place.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        type: { type: 'string', enum: ['decision', 'convention', 'lesson', 'bugfix', 'failed_approach'] },
      },
      required: ['title', 'text'],
    },
  },
];

type Json = Record<string, unknown>;

const asType = (v: unknown): MemoryType => (MEMORY_TYPES.includes(v as MemoryType) ? (v as MemoryType) : 'fact');
const asTags = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function callTool(cwd: string, name: string, args: Json): string {
  if (name === 'recall_context') {
    return formatHitsCompact(context(cwd, String(args.query ?? ''), { limit: Number(args.limit) || 5 }));
  }
  if (name === 'recall_where') {
    return formatWhere(whereIs(cwd, String(args.name ?? args.query ?? '')));
  }
  if (name === 'recall_remember') {
    const r = agentRemember(cwd, { title: String(args.title ?? ''), text: String(args.text ?? ''), type: asType(args.type), tags: asTags(args.tags) });
    return `${r.action === 'updated' ? 'Updated' : 'Saved'} ${r.memory.id} (${r.memory.status}).`;
  }
  // ---- Legacy tools: callable for older clients, deliberately not listed ----
  if (name === 'recall_propose') {
    const m = propose(cwd, { title: String(args.title ?? ''), text: String(args.text ?? ''), type: asType(args.type), tags: asTags(args.tags) });
    return `Proposed ${m.id} at ${m.file}. A human must run \`recall approve ${m.id}\`.`;
  }
  if (name === 'recall_checkpoint') {
    const summary = args.summary ? String(args.summary) : undefined;
    const nextSteps = args.nextSteps ? String(args.nextSteps) : undefined;
    const res = checkpoint(cwd, summary, { nextSteps, auto: !args.summary });
    return `Checkpoint recorded [${res.timestamp}]: ${res.summary}`;
  }
  if (name === 'recall_map') {
    return `Project map refreshed at ${map(cwd)}.`;
  }
  if (name === 'recall_status') {
    const s = status(cwd);
    const types = Object.entries(s.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    const statuses = Object.entries(s.byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    return `Recall Status:\n- Types: ${types}\n- Statuses: ${statuses}\n- Index: ${s.index}\n- Problems: ${s.problems}`;
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
