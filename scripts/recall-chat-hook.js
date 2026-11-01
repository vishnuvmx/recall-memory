#!/usr/bin/env node
/**
 * Universal multi-agent lifecycle hook & stdin chat processor.
 *
 * Compatible with:
 *   - Google Antigravity (.agents/hooks.json Stop / SessionStart)
 *   - Claude Code (.claude/settings.local.json Stop)
 *   - Cursor (.cursor/hooks.json stop)
 *   - Terminal / Local LLM pipes:
 *       echo "Decision: Keep SQLite in WAL mode for concurrent reads." | node scripts/recall-chat-hook.js
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localDistIndex = path.resolve(__dirname, '..', 'dist', 'index.js');

async function main() {
  if (fs.existsSync(localDistIndex)) {
    const { runLifecycleHook } = await import(`file://${localDistIndex.replace(/\\/g, '/')}`);
    const out = await runLifecycleHook(process.cwd());
    process.stdout.write(`${out}\n`);
    return;
  }

  // Fallback to globally installed `recall hook` if dist/ is not built locally
  const res = spawnSync('recall', ['hook'], {
    stdio: ['inherit', 'pipe', 'ignore'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  process.stdout.write(res.stdout?.trim() ? `${res.stdout.trim()}\n` : '{}\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
});

