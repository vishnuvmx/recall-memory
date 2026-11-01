#!/usr/bin/env node
/**
 * Model-agnostic non-volatile context pack exporter.
 *
 * Prints the compact `.recall/PASSPORT.md` blueprint + optional hybrid search hits
 * so ANY local or web AI model (Ollama, LM Studio, Aider, ChatGPT, Claude, DeepSeek, Gemini)
 * starts warm in ~400-800 tokens with zero cold-run repository scanning.
 *
 * Usage:
 *   node scripts/recall-context-pack.js
 *   node scripts/recall-context-pack.js "authentication token isolation"
 */
import fs from 'node:fs';
import { contextHybrid, formatHybridHitsCompact, passport, requireInitialized } from '../dist/index.js';
import { extractManagedBlock } from '../dist/utils/managed.js';

const query = process.argv.slice(2).join(' ').trim();
const p = requireInitialized(process.cwd());
const pass = passport(p.root);
const rawPassport = fs.readFileSync(pass.file, 'utf8');
const cleanPassport = extractManagedBlock(rawPassport, 'recall:passport') ?? rawPassport.trim();

const sections = [cleanPassport];

if (query) {
  const hits = contextHybrid(p.root, query, { limit: 5 });
  sections.push(
    '',
    `## Targeted Context for: "${query}"`,
    formatHybridHitsCompact(hits),
  );
}

process.stdout.write(`${sections.join('\n')}\n`);

