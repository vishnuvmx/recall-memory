#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { costReport } from '../core/cost.js';
import { runDoctor } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import { rebuildIndex } from '../core/index-builder.js';
import { formatHitsCompact } from '../core/retrieval.js';
import { agentRemember, approve, approveAll, archive, archiveAll, checkpoint, context, getProposals, log, map, propose, prune, status, undo, whereIs } from '../core/service.js';
import { seed } from '../core/seed.js';
import { requireInitialized } from '../core/project.js';
import { formatWhere } from '../core/where.js';
import { serveStdio } from '../mcp/server.js';
import { MEMORY_TYPES, PROFILE_TIERS, type MemoryType, type ProfileTier } from '../schemas/index.js';
import { RecallError } from '../utils/fs.js';

const cwd = (): string => process.cwd();
const collect = (v: string, prev: string[]): string[] => [...prev, v];
const parseType = (v: string): MemoryType => {
  if (!MEMORY_TYPES.includes(v as MemoryType)) throw new InvalidArgumentError(`Must be one of: ${MEMORY_TYPES.join(', ')}`);
  return v as MemoryType;
};
const parseLimit = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Must be a positive integer.');
  return n;
};
const print = (s = ''): void => console.log(s);

const program = new Command('recall')
  .description('Zero-maintenance, local-first project memory for AI coding agents. Plain Markdown, no network.')
  .version('0.1.0');

program
  .command('init')
  .description('Create .recall/ and install the managed agent-instruction block (idempotent, never overwrites)')
  .option('--no-agent', 'do not touch the agent instruction file')
  .option('--profile <tier>', `model context tier (${PROFILE_TIERS.join('|')})`, 'standard')
  .action((o: { agent: boolean; profile: string }) => {
    if (!PROFILE_TIERS.includes(o.profile as ProfileTier)) {
      throw new InvalidArgumentError(`--profile must be one of: ${PROFILE_TIERS.join(', ')}`);
    }
    const r = initProject(cwd(), { agent: o.agent, profile: o.profile as ProfileTier });
    print(`Project root: ${r.project.root} (${r.project.source === 'cwd' ? 'no Git repo or .recall found; using current directory' : `found via ${r.project.source}`})`);
    for (const f of r.created) print(`  created  ${f}`);
    for (const f of r.skipped) print(`  kept     ${f}`);
    print(`Agent instructions: ${r.agent}`);
    print('\nDone. Agents now look things up and record learnings on their own; no further commands needed.');
    print('Run `recall cost` to see exactly what Recall adds to your agent context.');
    print('Nothing was staged or committed. Review with `git status`, then commit when ready.');
  });

program
  .command('status')
  .description('Show memory counts, index health, agent integration and Recall-only Git changes')
  .option('--json', 'output status as JSON')
  .action((o: { json?: boolean }) => {
    const s = status(cwd());
    if (o.json) {
      print(JSON.stringify(s, null, 2));
      return;
    }
    print(`Project root: ${s.project.root}`);
    print('Initialized: yes');
    const fmt = (o: Record<string, number>): string => (Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
    print(`By type:   ${fmt(s.byType)}`);
    print(`By status: ${fmt(s.byStatus)}`);
    if (s.problems) print(`Malformed memory files: ${s.problems} (run \`recall doctor\`)`);
    print(`Index: ${s.index}${s.index === 'up_to_date' ? '' : ' (run `recall rebuild`)'}`);
    print(`Agent file ${s.agentFile}: ${s.agent}`);

    if (s.tokens) {
      print('On-demand files (never loaded unless explicitly read; see `recall cost` for always-on cost):');
      for (const [file, tok] of Object.entries(s.tokens.files)) {
        if (tok > 0) print(`  - ${file.padEnd(18)} ~${tok.toLocaleString()} tokens`);
      }
    }

    if (!s.git.available) print('Git: not installed');
    else if (!s.git.isRepo) print('Git: not a repository (no change tracking)');
    else if (!s.git.changes || s.git.changes.length === 0) print('Recall changes (uncommitted): none');
    else {
      print('Recall changes (uncommitted, .recall/ only):');
      for (const c of s.git.changes) print(`  ${c}`);
    }
  });

program
  .command('remember')
  .description('Save a memory. Active immediately when config `writes` is "auto" (default); similar titles update in place')
  .argument('<text>', 'the memory text')
  .option('-t, --title <title>', 'title (defaults to the first line of the text)')
  .option('--type <type>', `one of ${MEMORY_TYPES.join('|')}`, parseType, 'fact' as MemoryType)
  .option('--tag <tag>', 'tag (repeatable)', collect, [] as string[])
  .option('--source <ref>', 'source reference, e.g. a file path or URL (repeatable)', collect, [] as string[])
  .option('--active', 'force active status regardless of write mode')
  .option('--approved', 'alias for --active')
  .option('--proposed', 'force proposed status (needs `recall approve`)')
  .action((text: string, o: { title?: string; type: MemoryType; tag: string[]; source: string[]; active?: boolean; approved?: boolean; proposed?: boolean }) => {
    const title = o.title ?? (text.split('\n')[0] ?? '').slice(0, 80);
    const forced = o.active || o.approved ? 'active' : o.proposed ? 'proposed' : undefined;
    const r = agentRemember(cwd(), { title, text, type: o.type, tags: o.tag, sources: o.source, status: forced });
    const m = r.memory;
    print(`${r.action === 'updated' ? 'Updated' : 'Saved'} ${m.id} (${m.type}, ${m.status}, ${m.verification}) -> .recall/${m.file}`);
    if (m.status === 'proposed') print(`  Proposed: run \`recall approve ${m.id}\` to make it searchable.`);
  });

program
  .command('propose')
  .description('Propose a memory (status: proposed). A human approves it with `recall approve`')
  .argument('<text>')
  .requiredOption('-t, --title <title>')
  .option('--type <type>', `one of ${MEMORY_TYPES.join('|')}`, parseType, 'fact' as MemoryType)
  .option('--tag <tag>', 'tag (repeatable)', collect, [] as string[])
  .action((text: string, o: { title: string; type: MemoryType; tag: string[] }) => {
    const m = propose(cwd(), { title: o.title, text, type: o.type, tags: o.tag, sources: ['proposed'] });
    print(`Proposed ${m.id} -> .recall/${m.file}\nReview it, then run: recall approve ${m.id}  (or: recall archive ${m.id})`);
  });

program
  .command('approve')
  .description('Activate a proposed memory')
  .argument('<id>')
  .action((id: string) => {
    const m = approve(cwd(), id);
    print(`Approved ${m.id}: ${m.title}`);
  });

program
  .command('archive')
  .description('Archive a memory (kept on disk, excluded from search; never deletes)')
  .argument('<id>')
  .action((id: string) => {
    const m = archive(cwd(), id);
    print(`Archived ${m.id}: ${m.title}`);
  });

program
  .command('context')
  .description('Retrieve relevant memories by deterministic keyword search (compact, capped at ~400 tokens)')
  .argument('<task>', 'task description')
  .option('-n, --limit <n>', 'max results', parseLimit, 5)
  .option('--format <format>', 'text|json', 'text')
  .option('--verbose', 'show scores and status details (for humans; not capped)')
  .option('--type <type>', `filter by memory type (${MEMORY_TYPES.join('|')})`, parseType)
  .option('--tag <tag>', 'filter by tag')
  .option('--include-proposed', 'include unapproved proposals')
  .option('--include-archived', 'include archived memories')
  .action((task: string, o: { limit: number; format: string; verbose?: boolean; type?: MemoryType; tag?: string; includeProposed?: boolean; includeArchived?: boolean }) => {
    if (o.format !== 'text' && o.format !== 'json') throw new RecallError('--format must be text or json.');
    const hits = context(cwd(), task, {
      limit: o.limit,
      type: o.type,
      tag: o.tag,
      includeProposed: !!o.includeProposed,
      includeArchived: !!o.includeArchived,
    });
    if (o.format === 'json') {
      print(JSON.stringify(hits.map((h) => ({
        id: h.memory.id, title: h.memory.title, type: h.memory.type, status: h.memory.status,
        verification: h.memory.verification, file: `.recall/${h.memory.file}`, score: h.score, excerpt: h.excerpt,
      })), null, 2));
      return;
    }
    if (!o.verbose) {
      print(formatHitsCompact(hits));
      return;
    }
    if (hits.length === 0) {
      print('No relevant memory found (keyword match on titles, tags, headings and body).');
      return;
    }
    hits.forEach((h, i) => {
      print(`${i + 1}. ${h.memory.title}  [score: ${h.score} | ${h.memory.type} | ${h.memory.status} | ${h.memory.verification}]`);
      print(`   .recall/${h.memory.file}`);
      if (h.excerpt) print(`   ${h.excerpt}`);
    });
  });

program
  .command('where')
  .description('Find a symbol or file and print file:line rows (live, cached scan; cheaper than reading PROJECT_MAP.md)')
  .argument('<name>', 'symbol name, partial name, or path fragment')
  .option('-n, --limit <n>', 'max results', parseLimit, 15)
  .action((name: string, o: { limit: number }) => {
    print(formatWhere(whereIs(cwd(), name, o.limit)));
  });

program
  .command('cost')
  .description('Show what Recall adds to your agent context: always-on vs on-demand tokens (estimates)')
  .option('--json', 'output as JSON')
  .action((o: { json?: boolean }) => {
    const r = costReport(cwd());
    if (o.json) {
      print(JSON.stringify(r, null, 2));
      return;
    }
    const row = (l: { source: string; tokens: number; note?: string }): void =>
      print(`  ${l.source.padEnd(40)} ~${String(l.tokens).padStart(5)} tok${l.note ? `  (${l.note})` : ''}`);
    print('Always-on (sent with every agent turn):');
    r.alwaysOn.forEach(row);
    print(`  ${'TOTAL'.padEnd(40)} ~${String(r.alwaysOnTotal).padStart(5)} tok`);
    print('\nMCP (only if configured):');
    row(r.mcp);
    print('\nOn-demand (only when the agent asks):');
    r.onDemand.forEach(row);
    print('\nEstimates use ~4 characters per token.');
    if (r.warnings.length > 0) {
      print('\nWarnings:');
      for (const w of r.warnings) print(`  ! ${w}`);
      process.exitCode = 1;
    }
  });

program
  .command('seed')
  .description('Analyze git history and documentation to propose initial architectural memories')
  .option('--from <source>', 'git|docs|all', 'all')
  .option('-n, --limit <n>', 'max items to propose', parseLimit, 5)
  .option('--dry-run', 'preview proposed memories without saving to disk')
  .action((o: { from: string; limit: number; dryRun?: boolean }) => {
    if (o.from !== 'git' && o.from !== 'docs' && o.from !== 'all') {
      throw new RecallError('--from must be git, docs, or all.');
    }
    const res = seed(cwd(), { from: o.from as 'git' | 'docs' | 'all', limit: o.limit, dryRun: o.dryRun });
    if (res.proposed.length === 0) {
      print(`No candidates found to seed from ${res.sourcesUsed.join(', ') || o.from}.`);
      return;
    }
    if (res.dryRun) {
      print(`[Dry Run] Found ${res.proposed.length} candidate(s) to seed:`);
      for (const p of res.proposed) {
        print(`  - [${p.type}] ${p.title} (source: ${p.source})`);
      }
      print('\nRun without --dry-run to propose them.');
    } else {
      print(`Seeded ${res.proposed.length} proposed memor${res.proposed.length === 1 ? 'y' : 'ies'}:`);
      for (const p of res.proposed) {
        print(`  - ${p.id}: ${p.title} [${p.type}] (source: ${p.source})`);
      }
      print('\nRun `recall review` or `recall approve <id>` to activate them.');
    }
  });

program
  .command('review')
  .description('Review proposed memories and approve or archive them in batch')
  .option('--approve-all', 'approve all currently proposed memories')
  .option('--archive-all', 'archive all currently proposed memories')
  .action((o: { approveAll?: boolean; archiveAll?: boolean }) => {
    if (o.approveAll) {
      const approved = approveAll(cwd());
      if (approved.length === 0) {
        print('No proposed memories to approve.');
      } else {
        print(`Approved ${approved.length} memor${approved.length === 1 ? 'y' : 'ies'}:`);
        for (const m of approved) print(`  - ${m.id}: ${m.title}`);
      }
      return;
    }
    if (o.archiveAll) {
      const archived = archiveAll(cwd());
      if (archived.length === 0) {
        print('No proposed memories to archive.');
      } else {
        print(`Archived ${archived.length} memor${archived.length === 1 ? 'y' : 'ies'}:`);
        for (const m of archived) print(`  - ${m.id}: ${m.title}`);
      }
      return;
    }
    const proposals = getProposals(cwd());
    if (proposals.length === 0) {
      print('No pending proposed memories. Memory is up to date.');
      return;
    }
    print(`Found ${proposals.length} pending proposed memor${proposals.length === 1 ? 'y' : 'ies'}:`);
    for (const m of proposals) {
      print(`  ${m.id} [${m.type}] ${m.title}`);
      print(`    file: .recall/${m.file}`);
      if (m.tags.length > 0) print(`    tags: ${m.tags.join(', ')}`);
    }
    print('\nTo approve all: recall review --approve-all');
    print('To approve one: recall approve <id>');
    print('To archive one: recall archive <id>');
  });

program
  .command('rebuild')
  .description('Rebuild INDEX.md deterministically from valid memory files')
  .action(() => {
    const p = requireInitialized(cwd());
    const l = rebuildIndex(p.recallDir);
    print(`Index rebuilt: ${l.memories.length} memories, ${l.plainDocs.length} rule documents.`);
    for (const pr of l.problems) print(`  skipped (malformed, not deleted): ${pr.file} - ${pr.error}`);
  });

program
  .command('undo')
  .description('Discard uncommitted changes and remove untracked files in .recall/ (never touches gitignored files)')
  .option('--dry-run', 'preview files that would be restored or deleted without modifying anything')
  .option('-f, --force', 'force deletion of untracked memory files without interactive confirmation')
  .action((o: { dryRun?: boolean; force?: boolean }) => {
    if (!o.dryRun && !o.force) {
      const preview = undo(cwd(), { dryRun: true });
      if (preview.cleaned && preview.cleaned.length > 0) {
        throw new RecallError(
          `undo would delete ${preview.cleaned.length} untracked file(s) in .recall/:\n` +
          preview.cleaned.map((f) => `    ${f}`).join('\n'),
          'Pass --force to permanently delete untracked files, or --dry-run to inspect them safely.'
        );
      }
    }
    const res = undo(cwd(), { dryRun: o.dryRun });
    if (!res.ok) throw new RecallError(res.message);
    print(res.message);
    if (res.restored && res.restored.length > 0) {
      print('  Tracked files restored:');
      for (const f of res.restored) print(`    ${f}`);
    }
    if (res.cleaned && res.cleaned.length > 0) {
      print('  Untracked files deleted:');
      for (const f of res.cleaned) print(`    ${f}`);
    }
  });

program
  .command('doctor')
  .description('Diagnose configuration, files, index, agent integration and Git (never repairs automatically)')
  .action(() => {
    const checks = runDoctor(cwd());
    for (const c of checks) {
      print(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      if (!c.ok && c.fix) print(`       fix: ${c.fix}`);
    }
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command('log')
  .description('Recent Recall changes (read-only Git history, or local changelog fallback)')
  .option('-n, --limit <n>', 'max entries', parseLimit, 10)
  .action((o: { limit: number }) => {
    const r = log(cwd(), o.limit);
    if (r.source === 'git') {
      print('Committed history (.recall/ only):');
      if (r.committed.length === 0) print('  (no commits touching .recall/ yet)');
      for (const c of r.committed) print(`  ${c.hash}  ${c.date}  ${c.subject}`);
      print('\nUncommitted changes:');
      if (r.uncommitted.length === 0) print('  none');
      for (const u of r.uncommitted) print(`  ${u}`);
    } else {
      print('Git history unavailable; showing the local changelog (NOT a complete history):');
      if (r.changelog.length === 0) print('  (empty)');
      for (const l of r.changelog) print(`  ${l}`);
    }
  });

program
  .command('map')
  .description('Generate or refresh .recall/PROJECT_MAP.md (directory topology, entry points, configs, landmarks)')
  .option('--profile <tier>', `context tier (${PROFILE_TIERS.join('|')})`)
  .action((o: { profile?: string }) => {
    if (o.profile && !PROFILE_TIERS.includes(o.profile as ProfileTier)) {
      throw new InvalidArgumentError(`--profile must be one of: ${PROFILE_TIERS.join(', ')}`);
    }
    const file = map(cwd(), o.profile as ProfileTier | undefined);
    print(`Project map generated: ${file}`);
    print('Agents should prefer `recall where <name>` (a few lines) over reading the whole map.');
  });

program
  .command('checkpoint')
  .alias('session')
  .description('Record an iteration checkpoint in .recall/CURRENT_STATE.md and the session log (normally run by the agent Stop hook)')
  .argument('[summary]', 'summary of what was accomplished in this iteration')
  .option('-n, --next <steps>', 'immediate next steps for following prompts (only if work remains half-done)')
  .option('--clear', 'clear active state and mark all previous work as completed')
  .option('--auto', 'auto-generate summary from git changes; skipped when nothing changed')
  .option('--hook', 'agent lifecycle hook mode: auto checkpoint, print `{}` (hook JSON), never fail')
  .option('--retention <days>', 'retention window in days for session log history (default: 14)')
  .action((summary: string | undefined, o: { next?: string; clear?: boolean; auto?: boolean; hook?: boolean; retention?: string }) => {
    if (o.hook) {
      try {
        checkpoint(cwd(), undefined, { auto: true });
      } catch {
        // A memory bookkeeping failure must never block or break the agent loop.
      }
      print('{}');
      return;
    }
    const retentionDays = o.retention ? parseInt(o.retention, 10) : undefined;
    const res = checkpoint(cwd(), summary, { nextSteps: o.next, clear: o.clear, auto: o.auto, retentionDays });
    if (res.skipped) {
      print('No changes since the last checkpoint; nothing recorded.');
      return;
    }
    print(`Checkpoint recorded [${res.timestamp}]:`);
    print(`  Summary: ${res.summary}`);
    if (res.nextSteps) print(`  Next:    ${res.nextSteps}`);
    if (res.modifiedFiles.length > 0) {
      print(`  Active files (${res.modifiedFiles.length}):`);
      for (const f of res.modifiedFiles.slice(0, 5)) print(`    ${f}`);
      if (res.modifiedFiles.length > 5) print(`    ... (${res.modifiedFiles.length - 5} more)`);
    }
  });

program
  .command('prune')
  .description('Prune session log entries older than retention window (default: 14 days)')
  .option('-d, --days <days>', 'retention window in days (default: 14)', '14')
  .option('-m, --max <count>', 'maximum number of session entries to retain (default: 50)', '50')
  .action((o: { days: string; max: string }) => {
    const days = parseInt(o.days, 10);
    const max = parseInt(o.max, 10);
    const res = prune(cwd(), { retentionDays: days, maxEntries: max });
    print(`Session log pruned:`);
    print(`  Removed:   ${res.removedCount} old entries`);
    print(`  Remaining: ${res.remainingCount} entries within ${days}-day retention window.`);
  });


program
  .command('serve')
  .description('Run a local MCP server over stdio exposing recall_context, recall_where and recall_remember')
  .action(() => {
    requireInitialized(cwd());
    serveStdio(cwd());
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof RecallError) {
    console.error(`recall: ${err.message}`);
    if (err.hint) console.error(`hint: ${err.hint}`);
  } else {
    console.error(`recall: unexpected error: ${(err as Error).message}`);
  }
  process.exitCode = 1;
}
