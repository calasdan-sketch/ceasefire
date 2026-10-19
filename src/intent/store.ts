/**
 * Intent store: SQLite-backed CRUD with TTL expiry.
 *
 * Zero runtime dependencies — uses node:sqlite (built into Node >= 22).
 * better-sqlite3 was rejected: it needs node-gyp compilation at install
 * time, which breaks `npx ceasefire` on machines without a toolchain.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Intent } from '../types.js';

/** Default intent TTL: 4 hours. */
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

export interface PublishOptions {
  agent: string;
  branch: string;
  /** Milliseconds until the intent lapses. Defaults to 4h. */
  ttlMs?: number;
  /** Override for tests. */
  now?: number;
}

export interface ListOptions {
  agent?: string;
  status?: Intent['status'];
  /** Override for tests. */
  now?: number;
}

interface IntentRow {
  id: string;
  agent: string;
  task: string;
  branch: string;
  paths: string;
  created_at: number;
  expires_at: number;
  status: Intent['status'];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  task TEXT NOT NULL,
  branch TEXT NOT NULL,
  paths TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_agent ON intents(agent);
`;

function rowToIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    agent: row.agent,
    task: row.task,
    branch: row.branch,
    paths: JSON.parse(row.paths) as string[],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

export class IntentStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Concurrency hardening: parallel agents routinely `ceasefire start` (write)
    // while another runs `ceasefire check` (which expires intents — also a
    // write). Without these, the loser gets SQLITE_BUSY instantly and the
    // command fails with exit 1.
    // - busy_timeout: wait up to 5s for a lock instead of failing at once.
    // - journal_mode=WAL: readers never block writers (and vice versa).
    // - synchronous=NORMAL: the safe pairing for WAL; durability is not
    //   critical here — intents are advisory and re-broadcast on publish.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /** Publish a new active intent. Throws on invalid input. */
  publish(task: string, paths: string[], opts: PublishOptions): Intent {
    const cleanTask = task.trim();
    if (!cleanTask) throw new Error('ceasefire: intent task must be a non-empty string');
    const cleanPaths = paths.map((p) => p.trim()).filter((p) => p.length > 0);
    if (cleanPaths.length === 0) throw new Error('ceasefire: intent must claim at least one path');
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`ceasefire: ttlMs must be a positive number of milliseconds (got ${String(opts.ttlMs)})`);
    }
    if (!opts.agent.trim()) throw new Error('ceasefire: agent identity must be a non-empty string');

    const now = opts.now ?? Date.now();
    const intent: Intent = {
      id: randomUUID(),
      agent: opts.agent,
      task: cleanTask,
      branch: opts.branch,
      paths: cleanPaths,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'active',
    };
    this.db
      .prepare(
        `INSERT INTO intents (id, agent, task, branch, paths, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.agent,
        intent.task,
        intent.branch,
        JSON.stringify(intent.paths),
        intent.createdAt,
        intent.expiresAt,
        intent.status,
      );
    return intent;
  }

  /** List intents, expiring lapsed ones first. */
  list(opts: ListOptions = {}): Intent[] {
    this.expire(opts.now);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.agent !== undefined) {
      clauses.push('agent = ?');
      params.push(opts.agent);
    }
    if (opts.status !== undefined) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM intents ${where} ORDER BY created_at ASC`)
      .all(...params) as unknown as IntentRow[];
    return rows.map(rowToIntent);
  }

  /** Fetch one intent by id, or null. */
  get(id: string): Intent | null {
    this.expire();
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as unknown as
      | IntentRow
      | undefined;
    return row ? rowToIntent(row) : null;
  }

  /** Mark an intent done. Returns the updated intent, or null if unknown. */
  complete(id: string): Intent | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.prepare("UPDATE intents SET status = 'done' WHERE id = ?").run(id);
    return { ...existing, status: 'done' };
  }

  /**
   * Insert an intent known from elsewhere (e.g. a git-refs broadcast) into
   * the local store. Existing rows are replaced wholesale.
   */
  upsert(intent: Intent): void {
    this.db
      .prepare(
        `INSERT INTO intents (id, agent, task, branch, paths, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent, task = excluded.task, branch = excluded.branch,
           paths = excluded.paths, created_at = excluded.created_at,
           expires_at = excluded.expires_at, status = excluded.status`,
      )
      .run(
        intent.id,
        intent.agent,
        intent.task,
        intent.branch,
        JSON.stringify(intent.paths),
        intent.createdAt,
        intent.expiresAt,
        intent.status,
      );
  }

  /**
   * Flip lapsed active intents to 'expired'. Returns the number flipped.
   * Called lazily by list()/get() so readers never see stale actives.
   */
  expire(now: number = Date.now()): number {
    const result = this.db
      .prepare("UPDATE intents SET status = 'expired' WHERE status = 'active' AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
