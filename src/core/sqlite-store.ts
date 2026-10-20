import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Memory } from './memory.js';
import { globalWriteQueue, withRetry } from './write-queue.js';
import { getOrGenerateEmbedding, CURRENT_EMBEDDING_MODEL, CURRENT_EMBEDDING_VERSION } from './embeddings.js';
import type { SecurityContext } from '../security/isolation.js';
import { canReadResource } from '../security/isolation.js';

export interface DbMemoryRow {
  id: string;
  title: string;
  type: string;
  body: string;
  file: string;
  created: string;
  updated: string;
  status: string;
  verification: string;
  confidence: number;
  evidence: string;
  valid_from: string | null;
  expires_at: string | null;
  version: number;
  superseded_by: string | null;
  deprecated: number;
  deprecated_reason: string | null;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  user_id: string | null;
  visibility: string;
  tags: string;
  sources: string;
}

export class SqliteMemoryStore {
  private db: DatabaseSync;
  private isClosed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    // Enable WAL mode for high concurrency
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // In-memory databases or some platforms might ignore or throw on WAL
    }
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        file TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        status TEXT NOT NULL,
        verification TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        evidence TEXT NOT NULL DEFAULT '[]',
        valid_from TEXT,
        expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        deprecated INTEGER NOT NULL DEFAULT 0,
        deprecated_reason TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        workspace_id TEXT NOT NULL DEFAULT 'default',
        project_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'workspace',
        tags TEXT NOT NULL DEFAULT '[]',
        sources TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_tenant_ws ON memories(tenant_id, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        title,
        tags,
        body,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vector TEXT NOT NULL,
        updated TEXT NOT NULL
      );
    `);
  }

  private rowToMemory(r: DbMemoryRow): Memory {
    return {
      id: r.id,
      title: r.title,
      type: r.type as Memory['type'],
      body: r.body,
      file: r.file,
      created: r.created,
      updated: r.updated,
      status: r.status as Memory['status'],
      verification: r.verification as Memory['verification'],
      confidence: r.confidence,
      evidence: JSON.parse(r.evidence || '[]'),
      validFrom: r.valid_from ?? undefined,
      expiresAt: r.expires_at ?? undefined,
      version: r.version,
      supersededBy: r.superseded_by ?? undefined,
      deprecated: r.deprecated === 1,
      deprecatedReason: r.deprecated_reason ?? undefined,
      tenantId: r.tenant_id,
      workspaceId: r.workspace_id,
      projectId: r.project_id,
      userId: r.user_id ?? undefined,
      visibility: r.visibility as Memory['visibility'],
      tags: JSON.parse(r.tags || '[]'),
      sources: JSON.parse(r.sources || '[]'),
    };
  }

  /**
   * Upserts a memory synchronously inside a short transaction,
   * guaranteeing read-after-write consistency.
   */
  upsertMemorySync(m: Memory): void {
    const upsertStmt = this.db.prepare(`
      INSERT INTO memories (
        id, title, type, body, file, created, updated, status, verification,
        confidence, evidence, valid_from, expires_at, version, superseded_by,
        deprecated, deprecated_reason, tenant_id, workspace_id, project_id,
        user_id, visibility, tags, sources
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        type = excluded.type,
        body = excluded.body,
        file = excluded.file,
        updated = excluded.updated,
        status = excluded.status,
        verification = excluded.verification,
        confidence = excluded.confidence,
        evidence = excluded.evidence,
        valid_from = excluded.valid_from,
        expires_at = excluded.expires_at,
        version = excluded.version,
        superseded_by = excluded.superseded_by,
        deprecated = excluded.deprecated,
        deprecated_reason = excluded.deprecated_reason,
        tenant_id = excluded.tenant_id,
        workspace_id = excluded.workspace_id,
        project_id = excluded.project_id,
        user_id = excluded.user_id,
        visibility = excluded.visibility,
        tags = excluded.tags,
        sources = excluded.sources;
    `);

    const ftsDeleteStmt = this.db.prepare('DELETE FROM memories_fts WHERE id = ?;');
    const ftsInsertStmt = this.db.prepare('INSERT INTO memories_fts (id, title, tags, body) VALUES (?, ?, ?, ?);');

    // Run short transaction
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      upsertStmt.run(
        m.id,
        m.title,
        m.type,
        m.body,
        m.file,
        m.created,
        m.updated,
        m.status,
        m.verification,
        m.confidence ?? 1.0,
        JSON.stringify(m.evidence ?? []),
        m.validFrom ?? null,
        m.expiresAt ?? null,
        m.version ?? 1,
        m.supersededBy ?? null,
        m.deprecated ? 1 : 0,
        m.deprecatedReason ?? null,
        m.tenantId ?? 'default',
        m.workspaceId ?? 'default',
        m.projectId ?? 'default',
        m.userId ?? null,
        m.visibility ?? 'workspace',
        JSON.stringify(m.tags ?? []),
        JSON.stringify(m.sources ?? []),
      );

      ftsDeleteStmt.run(m.id);
      ftsInsertStmt.run(m.id, m.title, (m.tags ?? []).join(' '), m.body);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    // Update embedding
    this.updateEmbeddingSync(m);
  }

  async upsertMemory(m: Memory): Promise<void> {
    return globalWriteQueue.enqueue(async () => {
      await withRetry(() => {
        this.upsertMemorySync(m);
      });
    });
  }

  private updateEmbeddingSync(m: Memory): void {
    const text = `${m.title}\n${(m.tags ?? []).join(' ')}\n${m.body}`;
    const emb = getOrGenerateEmbedding(text);

    const checkStmt = this.db.prepare('SELECT content_hash, model, version FROM embeddings WHERE id = ?;');
    const row = checkStmt.get(m.id) as { content_hash: string; model: string; version: number } | undefined;

    // Reuse embedding if content and model version haven't changed
    if (
      row &&
      row.content_hash === emb.contentHash &&
      row.model === CURRENT_EMBEDDING_MODEL &&
      row.version === CURRENT_EMBEDDING_VERSION
    ) {
      return;
    }

    const upsertEmb = this.db.prepare(`
      INSERT INTO embeddings (id, model, version, content_hash, vector, updated)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model = excluded.model,
        version = excluded.version,
        content_hash = excluded.content_hash,
        vector = excluded.vector,
        updated = excluded.updated;
    `);

    upsertEmb.run(
      m.id,
      emb.model,
      emb.version,
      emb.contentHash,
      JSON.stringify(emb.vector),
      new Date().toISOString(),
    );
  }

  deleteMemorySync(id: string): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM memories WHERE id = ?;').run(id);
      this.db.prepare('DELETE FROM memories_fts WHERE id = ?;').run(id);
      this.db.prepare('DELETE FROM embeddings WHERE id = ?;').run(id);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async deleteMemory(id: string): Promise<void> {
    return globalWriteQueue.enqueue(async () => {
      await withRetry(() => {
        this.deleteMemorySync(id);
      });
    });
  }

  getMemory(id: string, securityContext?: SecurityContext): Memory | undefined {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?;');
    const row = stmt.get(id) as DbMemoryRow | undefined;
    if (!row) return undefined;

    const mem = this.rowToMemory(row);
    if (securityContext && !canReadResource(securityContext, mem)) {
      return undefined;
    }
    return mem;
  }

  getAllMemories(securityContext?: SecurityContext): Memory[] {
    const stmt = this.db.prepare('SELECT * FROM memories ORDER BY id ASC;');
    const rows = stmt.all() as unknown as DbMemoryRow[];
    const memories = rows.map((r) => this.rowToMemory(r));

    if (!securityContext) return memories;
    return memories.filter((m) => canReadResource(securityContext, m));
  }

  getEmbedding(id: string): number[] | undefined {
    const stmt = this.db.prepare('SELECT vector FROM embeddings WHERE id = ?;');
    const row = stmt.get(id) as { vector: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.vector);
    } catch {
      return undefined;
    }
  }

  /**
   * Executes BM25 search over FTS5 virtual table.
   * Returns matching memory IDs and their BM25 score.
   */
  ftsBm25Search(query: string, limit = 20): Array<{ id: string; bm25Score: number }> {
    // Clean query for FTS5 syntax
    const cleaned = query
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"*`)
      .join(' OR ');

    if (!cleaned) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT id, bm25(memories_fts) as rank
        FROM memories_fts
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?;
      `);
      const rows = stmt.all(cleaned, limit) as unknown as Array<{ id: string; rank: number }>;
      // In SQLite FTS5, bm25() returns negative numbers where smaller (more negative) is better.
      // Convert to a positive score: -rank
      return rows.map((r) => ({ id: r.id, bm25Score: Math.max(0, -r.rank) }));
    } catch {
      return [];
    }
  }

  /**
   * Synchronizes markdown memory records into SQLite store.
   */
  syncFromMarkdown(memories: Memory[]): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existingIds = new Set(
        (this.db.prepare('SELECT id FROM memories;').all() as unknown as Array<{ id: string }>).map((r) => r.id),
      );
      const incomingIds = new Set(memories.map((m) => m.id));

      // Remove deleted
      for (const id of existingIds) {
        if (!incomingIds.has(id)) {
          this.db.prepare('DELETE FROM memories WHERE id = ?;').run(id);
          this.db.prepare('DELETE FROM memories_fts WHERE id = ?;').run(id);
          this.db.prepare('DELETE FROM embeddings WHERE id = ?;').run(id);
        }
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    for (const m of memories) {
      this.upsertMemorySync(m);
    }
  }

  close(): void {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
    }
  }
}

let sharedStore: SqliteMemoryStore | null = null;

export function getSharedSqliteStore(recallDir: string): SqliteMemoryStore {
  if (sharedStore) return sharedStore;
  const dbPath = path.join(recallDir, '.cache', 'recall.db');
  sharedStore = new SqliteMemoryStore(dbPath);
  return sharedStore;
}

export function closeSharedSqliteStore(): void {
  if (sharedStore) {
    sharedStore.close();
    sharedStore = null;
  }
}
