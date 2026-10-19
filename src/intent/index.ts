/**
 * Intent module: store re-exports plus store-directory resolution.
 *
 * Resolution order:
 *   1. CEASEFIRE_DIR env var (explicit override, used by tests and CI)
 *   2. <git-root>/.ceasefire when inside a git repo (repo-local, shared by
 *      every agent working in that checkout)
 *   3. ~/.ceasefire (fallback outside any repo)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { findGitRoot } from '../forecast/git.js';

export { IntentStore, DEFAULT_TTL_MS } from './store.js';
export type { PublishOptions, ListOptions } from './store.js';
import { IntentStore } from './store.js';

export function resolveStoreDir(cwd: string = process.cwd()): string {
  const envDir = process.env.CEASEFIRE_DIR;
  if (envDir && envDir.trim()) return envDir;
  const root = findGitRoot(cwd);
  if (root) return join(root, '.ceasefire');
  return join(homedir(), '.ceasefire');
}

export function resolveDbPath(cwd: string = process.cwd()): string {
  return join(resolveStoreDir(cwd), 'intents.db');
}

/**
 * Open the intent store, recovering from a corrupt database file.
 *
 * A corrupt `intents.db` (truncated write, disk error, stray file) must not
 * take down every ceasefire command: the ledger is advisory, so we quarantine
 * the bad file (`intents.db.corrupt-<timestamp>`, kept for forensics) and
 * start fresh. Genuine errors (unwritable directory, …) still throw.
 */
export function openIntentStore(dbPath: string): IntentStore {
  try {
    const store = new IntentStore(dbPath);
    // Touch the table: construction alone only validates the header.
    // A quick read+write proves the file is actually usable.
    store.expire();
    return store;
  } catch (e) {
    let quarantined = false;
    try {
      renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
      quarantined = true;
    } catch {
      // Nothing to move (or cannot move) — fall through to retry/fail.
    }
    if (quarantined) {
      // Best-effort: remove WAL sidecars so the fresh DB starts clean.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          renameSync(`${dbPath}${suffix}`, `${dbPath}${suffix}.corrupt-${Date.now()}`);
        } catch {
          /* sidecar may not exist */
        }
      }
      return new IntentStore(dbPath);
    }
    throw e;
  }
}
