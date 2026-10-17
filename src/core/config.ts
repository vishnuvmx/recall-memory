import fs from 'node:fs';
import path from 'node:path';
import { configSchema, type RecallConfig } from '../schemas/index.js';
import { RecallError, atomicWrite } from '../utils/fs.js';

export function configPath(recallDir: string): string {
  return path.join(recallDir, 'config.json');
}

export function defaultConfig(): RecallConfig {
  return { version: 1, agentFile: 'AGENTS.md', profile: 'standard', retentionDays: 14, maxLogEntries: 50 };
}

export function loadConfig(recallDir: string): RecallConfig {
  const file = configPath(recallDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new RecallError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RecallError(`${file} is not valid JSON.`, 'Fix the syntax or restore it from Git (`git checkout -- .recall/config.json`).');
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new RecallError(`Invalid config: ${msg}`, 'Fix .recall/config.json or restore it from Git.');
  }
  return parsed.data;
}

export function writeConfig(recallDir: string, cfg: RecallConfig): void {
  atomicWrite(configPath(recallDir), `${JSON.stringify(cfg, null, 2)}\n`);
}
