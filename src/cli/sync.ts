/**
 * Cross-machine intent broadcast via git refs.
 *
 * `ceasefire start` writes the intent JSON to refs/ceasefire/intents/<id> in the
 * local repo and pushes that ref to origin when one exists. `ceasefire check`
 * (and friends) fetch those refs before reading, so agents on different
 * machines see each other's intents.
 *
 * Everything here is best-effort: any git failure is swallowed and the
 * local SQLite store remains the source of truth. Set CEASEFIRE_SYNC=0 to
 * disable all network-touching behavior (tests and offline use).
 */
import { execFileSync } from 'node:child_process';
import { git, tryGit, hasRemote, findGitRoot } from '../forecast/git.js';
import type { Intent } from '../types.js';

const REF_PREFIX = 'refs/ceasefire/intents/';

/** Upper bound on intent refs pulled per fetch — bounds a flooding peer. */
const MAX_REMOTE_INTENTS = 500;
/** Upper bound on a single intent blob — the local DB must not bloat. */
const MAX_INTENT_BLOB_BYTES = 64 * 1024;
/** Intent ids travel inside git ref names; keep them ref-safe. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function syncEnabled(cwd: string): boolean {
  if (process.env.CEASEFIRE_SYNC === '0') return false;
  return findGitRoot(cwd) !== null && hasRemote(cwd);
}

/**
 * Validate a remotely-broadcast intent before it touches the local store.
 * Broadcasts are self-asserted (anyone with push access can plant one), so
 * the shape is checked strictly: wrong types, oversized blobs, or ref-
 * unsafe ids are dropped, never imported.
 */
function isValidRemoteIntent(parsed: unknown): parsed is Intent {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !SAFE_ID_RE.test(p['id'])) return false;
  if (typeof p['agent'] !== 'string' || typeof p['task'] !== 'string' || typeof p['branch'] !== 'string') {
    return false;
  }
  if (!Array.isArray(p['paths']) || !p['paths'].every((x) => typeof x === 'string')) return false;
  if (!Number.isFinite(p['createdAt']) || !Number.isFinite(p['expiresAt'])) return false;
  if (p['status'] !== 'active' && p['status'] !== 'done' && p['status'] !== 'expired') return false;
  // Keep absurd values out of the local DB: 10k paths or a 1MB task string
  // from a planted ref would slow every `ceasefire check`.
  if ((p['paths'] as string[]).length > 1000) return false;
  if (p['task'].length > 10_000 || p['agent'].length > 256 || p['branch'].length > 512) return false;
  return true;
}

/** Run git with `input` on stdin, return trimmed stdout. Throws on failure. */
function gitWithStdin(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/**
 * Publish an intent to refs/ceasefire/intents/<id> and push that ref to origin.
 * Best-effort: never throws; returns true when the push succeeded.
 */
export function broadcastIntent(cwd: string, intent: Intent): boolean {
  if (!syncEnabled(cwd)) return false;
  try {
    const blob = gitWithStdin(cwd, ['hash-object', '-w', '--stdin'], JSON.stringify(intent));
    const ref = `${REF_PREFIX}${intent.id}`;
    git(cwd, ['update-ref', ref, blob]);
    // Force is required: the ref points at a blob (non-commit), and git
    // rejects non-fast-forward updates of non-commit refs without --force.
    // Safe: we own the refs/ceasefire/intents/* namespace.
    return tryGit(cwd, ['push', '--quiet', '--force', 'origin', ref]) !== null;
  } catch {
    return false;
  }
}

/**
 * Fetch remote intent refs into the local view. Best-effort: never throws,
 * returns [] when sync is disabled or anything fails.
 */
export function fetchRemoteIntents(cwd: string): Intent[] {
  if (!syncEnabled(cwd)) return [];
  try {
    tryGit(cwd, ['fetch', '--quiet', 'origin', `+${REF_PREFIX}*:${REF_PREFIX}*`]);
    const refs = tryGit(cwd, ['for-each-ref', '--format=%(refname)', REF_PREFIX]);
    if (!refs) return [];
    const intents: Intent[] = [];
    const names = refs.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, MAX_REMOTE_INTENTS);
    for (const ref of names) {
      const blob = tryGit(cwd, ['cat-file', '-p', ref]);
      if (!blob || blob.length > MAX_INTENT_BLOB_BYTES) continue;
      try {
        const parsed: unknown = JSON.parse(blob);
        if (isValidRemoteIntent(parsed)) intents.push(parsed);
      } catch {
        /* skip malformed refs */
      }
    }
    return intents;
  } catch {
    return [];
  }
}
