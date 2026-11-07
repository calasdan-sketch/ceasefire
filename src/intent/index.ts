/**
 * Intent module: store re-exports plus store-directory resolution.
 *
 * Resolution order:
 *   1. CEASEFIRE_DIR env var (explicit override, used by tests and CI)
 *   2. <git-common-dir>/ceasefire when inside a git repo. The common dir is
 *      shared by the main checkout AND every `git worktree` of it, so agents
 *      in separate worktrees see each other's intents with no remote at all
 *      (0.2 used <worktree>/.ceasefire, which silently split the ledger per
 *      worktree). Living inside .git, it can never be committed or snapshotted.
 *   3. ~/.ceasefire (fallback outside any repo)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameSync, existsSync, statSync } from 'node:fs';
import { findGitRoot, tryGit } from '../forecast/git.js';

export { IntentStore, DEFAULT_TTL_MS, AUTO_LEASE_TASK } from './store.js';
export type { PublishOptions, ListOptions } from './store.js';
import { IntentStore } from './store.js';

export function resolveStoreDir(cwd: string = process.cwd()): string {
  const envDir = process.env.CEASEFIRE_DIR;
  if (envDir && envDir.trim()) return envDir;
  const root = findGitRoot(cwd);
  if (root) {
    const common = tryGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common) return join(common, 'ceasefire');
    return join(root, '.ceasefire');
  }
  return join(homedir(), '.ceasefire');
}

export function resolveDbPath(cwd: string = process.cwd()): string {
  return join(resolveStoreDir(cwd), 'intents.db');
}

/** SQLite primary result codes that mean "this file is not a usable database". */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** A WAL/SHM sidecar touched this recently may belong to a live connection. */
const LIVE_SIDECAR_MS = 60_000;

/** True only for genuine corruption — never for SQLITE_BUSY/LOCKED, I/O or permission errors. */
export function isCorruptionError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { errcode?: unknown }).errcode;
  if (typeof code !== 'number') return false;
  const primary = code & 0xff; // extended codes keep the primary code in the low byte
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
}

export class IntentStoreBusyError extends Error {
  constructor(dbPath: string, cause: unknown) {
    super(
      `the intent store ${dbPath} is busy or unavailable (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'another ceasefire process may hold a long lock. Nothing was changed — retry in a moment.',
    );
    this.name = 'IntentStoreBusyError';
  }
}

/**
 * Open the intent store, recovering from a corrupt database file.
 *
 * Only SQLITE_CORRUPT / SQLITE_NOTADB trigger recovery: the bad file is
 * quarantined (`intents.db.corrupt-<timestamp>`, kept for forensics) and a
 * fresh store is created. Lock contention (SQLITE_BUSY after the busy
 * timeout), I/O and permission errors never touch the files — they throw
 * IntentStoreBusyError, so a slow writer can never wipe every agent's
 * intents. WAL/SHM sidecars are moved only when stale (no write for 60s);
 * if a sidecar looks live, recovery is refused and the error is raised.
 */
export function openIntentStore(dbPath: string, opts: { busyTimeoutMs?: number } = {}): IntentStore {
  let first: unknown;
  try {
    const store = new IntentStore(dbPath, opts);
    try {
      // Touch the table: construction alone only validates the header.
      store.expire();
    } catch (e) {
      store.close();
      throw e;
    }
    return store;
  } catch (e) {
    first = e;
  }
  if (!isCorruptionError(first)) throw new IntentStoreBusyError(dbPath, first);
  const now = Date.now();
  const sidecars = ['-wal', '-shm', '-journal'].map((s) => `${dbPath}${s}`).filter((f) => existsSync(f));
  for (const f of sidecars) {
    try {
      if (now - statSync(f).mtimeMs < LIVE_SIDECAR_MS) {
        throw new IntentStoreBusyError(dbPath, new Error(`database looks corrupt but ${f} was written recently; refusing to move a live WAL`));
      }
    } catch (e) {
      if (e instanceof IntentStoreBusyError) throw e;
    }
  }
  const stamp = now;
  renameSync(dbPath, `${dbPath}.corrupt-${stamp}`);
  for (const f of sidecars) {
    try {
      renameSync(f, `${f}.corrupt-${stamp}`);
    } catch {
      /* already gone */
    }
  }
  return new IntentStore(dbPath, opts);
}
