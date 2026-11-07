/**
 * Intent store: SQLite-backed CRUD with TTL expiry.
 *
 * No npm dependency — uses node:sqlite (built into Node, unflagged since 22.13).
 * better-sqlite3 was rejected: it needs node-gyp compilation at install
 * time, which breaks `npx ceasefire` on machines without a toolchain.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Intent } from '../types.js';

/** Task text of the implicit, sliding-TTL lease the editor hook maintains per agent. */
export const AUTO_LEASE_TASK = 'editing (auto-lease)';

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

  constructor(dbPath: string, opts: { busyTimeoutMs?: number } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    const busy = opts.busyTimeoutMs ?? 5000;
    // Concurrency hardening: parallel agents routinely `ceasefire start` (write)
    // while another runs `ceasefire check` (which expires intents — also a
    // write). Without these, the loser gets SQLITE_BUSY instantly and the
    // command fails with exit 1.
    // - busy_timeout: wait up to 5s for a lock instead of failing at once.
    // - journal_mode=WAL: readers never block writers (and vice versa).
    // - synchronous=NORMAL: the safe pairing for WAL; durability is not
    //   critical here — intents are advisory and re-broadcast on publish.
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busy))}`);
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

  /**
   * Refresh the agent's implicit "lease" on a file (sliding TTL).
   *
   * An auto-lease is a normal intent whose task is AUTO_LEASE_TASK: one per
   * (agent, branch). Each edit adds the file to its paths and pushes the
   * expiry out by `ttlMs`, so a crashed or abandoned session stops holding
   * files `ttlMs` after its last edit with no cleanup step. The read-modify-
   * write runs in one IMMEDIATE transaction, so two edits racing from one
   * agent cannot lose a path.
   */
  touchLease(
    path: string,
    opts: { agent: string; branch: string; ttlMs: number; now?: number; maxPaths?: number },
  ): { intent: Intent; created: boolean; pathAdded: boolean } {
    if (!opts.agent.trim()) throw new Error('ceasefire: agent identity must be a non-empty string');
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) throw new Error('ceasefire: lease ttl must be positive');
    const now = opts.now ?? Date.now();
    const maxPaths = opts.maxPaths ?? 200;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM intents WHERE status = 'active' AND expires_at > ? AND agent = ? AND branch = ? AND task = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(now, opts.agent, opts.branch, AUTO_LEASE_TASK) as unknown as IntentRow | undefined;
      let result: { intent: Intent; created: boolean; pathAdded: boolean };
      if (row) {
        const intent = rowToIntent(row);
        const has = intent.paths.includes(path);
        const paths = has ? intent.paths : [...intent.paths, path].slice(-maxPaths);
        const expiresAt = Math.max(intent.expiresAt, now + opts.ttlMs);
        this.db.prepare('UPDATE intents SET paths = ?, expires_at = ? WHERE id = ?').run(JSON.stringify(paths), expiresAt, intent.id);
        result = { intent: { ...intent, paths, expiresAt }, created: false, pathAdded: !has };
      } else {
        const intent: Intent = {
          id: randomUUID(),
          agent: opts.agent,
          task: AUTO_LEASE_TASK,
          branch: opts.branch,
          paths: [path],
          createdAt: now,
          expiresAt: now + opts.ttlMs,
          status: 'active',
        };
        this.db
          .prepare('INSERT INTO intents (id, agent, task, branch, paths, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(intent.id, intent.agent, intent.task, intent.branch, JSON.stringify(intent.paths), intent.createdAt, intent.expiresAt, intent.status);
        result = { intent, created: true, pathAdded: true };
      }
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* no transaction left to roll back */
      }
      throw e;
    }
  }

  /** Complete every active intent of `agent` (optionally only auto-leases). Returns the completed intents. */
  completeAll(agent: string, opts: { onlyLeases?: boolean; now?: number } = {}): Intent[] {
    const mine = this.list({ agent, status: 'active', ...(opts.now !== undefined ? { now: opts.now } : {}) }).filter(
      (i) => !opts.onlyLeases || i.task === AUTO_LEASE_TASK,
    );
    for (const i of mine) this.db.prepare("UPDATE intents SET status = 'done' WHERE id = ?").run(i.id);
    return mine.map((i) => ({ ...i, status: 'done' as const }));
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
