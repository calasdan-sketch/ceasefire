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
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitResult, tryGit, hasRemote, findGitRoot } from '../forecast/git.js';
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
  if ((p['paths'] as string[]).some((x) => x.length > 4096)) return false;
  if (p['task'].length > 10_000 || p['agent'].length > 256 || p['branch'].length > 512) return false;
  return true;
}

/** Run git with `input` on stdin, return trimmed stdout. Throws on failure. */
function gitWithStdin(cwd: string, args: string[], input: string): string {
  return git(cwd, args, { input });
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
    return tryGit(cwd, ['push', '--quiet', '--force', 'origin', ref], { env: NETWORK_ENV, timeoutMs: fetchTimeoutMs() }) !== null;
  } catch {
    return false;
  }
}

/**
 * Non-interactive network env: git never prompts for credentials and the
 * Git Credential Manager never opens a dialog. The user's own SSH setup
 * (core.sshCommand / GIT_SSH_COMMAND) is left alone; a hanging SSH or HTTP
 * transport is bounded by the fetch timeout instead.
 */
const NETWORK_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  return Math.min(max, Math.max(min, parseInt(raw, 10)));
}

/** CEASEFIRE_FETCH_TIMEOUT_MS: hard cap on one fetch (default 5000, 500..60000). */
export function fetchTimeoutMs(): number {
  return envInt('CEASEFIRE_FETCH_TIMEOUT_MS', 5_000, 500, 60_000);
}

let fetchCaching = false;

/**
 * Turn on TTL-cached fetching for this process. The editor hook does this:
 * it runs on every Write/Edit, so a network round-trip per edit is too
 * expensive. Explicit commands (`check`, `list`, `conflicts`) always fetch.
 */
export function enableFetchCaching(on = true): void {
  fetchCaching = on;
}

/** CEASEFIRE_FETCH_TTL_S: with caching on, skip the fetch if one ran this recently (default 30, 0 = always). */
export function fetchTtlMs(): number {
  return fetchCaching ? envInt('CEASEFIRE_FETCH_TTL_S', 30, 0, 86_400) * 1000 : 0;
}

/** Stamp file recording the last fetch attempt, in the shared git dir. */
function stampPath(cwd: string): string | null {
  const common = tryGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? join(common, 'ceasefire-last-fetch') : null;
}

/** Fetch the intent refs unless a fetch ran within the TTL. Best-effort, bounded by the timeout. */
function maybeFetch(cwd: string): void {
  const ttl = fetchTtlMs();
  const stamp = stampPath(cwd);
  if (ttl > 0 && stamp) {
    try {
      if (Date.now() - statSync(stamp).mtimeMs < ttl) return;
    } catch {
      /* no stamp yet */
    }
  }
  // Stamp the *attempt* first: an unreachable remote then costs one timeout
  // per TTL window instead of one per edit.
  if (stamp && fetchCaching) {
    try {
      writeFileSync(stamp, `${new Date().toISOString()}\n`);
    } catch {
      /* read-only git dir: fetch every time, still bounded by the timeout */
    }
  }
  tryGit(cwd, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${REF_PREFIX}*:${REF_PREFIX}*`], {
    env: NETWORK_ENV,
    timeoutMs: fetchTimeoutMs(),
  });
}

/**
 * Remote intents from refs/ceasefire/intents/*. With `fetch` (default) the
 * refs are first refreshed from origin (TTL-cached, time-bounded); with
 * `fetch: false` only refs already present locally are read and nothing is
 * written. All blobs are read with one `git cat-file --batch`. Best-effort:
 * never throws, returns [] when sync is disabled or anything fails.
 */
export function fetchRemoteIntents(cwd: string, opts: { fetch?: boolean } = {}): Intent[] {
  if (!syncEnabled(cwd)) return [];
  try {
    if (opts.fetch ?? true) maybeFetch(cwd);
    const refs = tryGit(cwd, ['for-each-ref', '--format=%(objectname) %(objecttype) %(objectsize)', REF_PREFIX]);
    if (!refs) return [];
    const oids: string[] = [];
    for (const line of refs.split('\n').slice(0, MAX_REMOTE_INTENTS)) {
      const [oid, type, size] = line.trim().split(' ');
      if (!oid || !/^[0-9a-f]{40,64}$/.test(oid) || type !== 'blob') continue;
      if (Number(size) > MAX_INTENT_BLOB_BYTES) continue; // never even read oversized blobs
      oids.push(oid);
    }
    if (oids.length === 0) return [];
    const out = gitResult(cwd, ['cat-file', '--batch'], { input: oids.join('\n') + '\n' });
    if (out.exitCode !== 0) return [];
    return parseBatch(out.stdout).flatMap((blob) => {
      try {
        const parsed: unknown = JSON.parse(blob);
        return isValidRemoteIntent(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Parse `git cat-file --batch` output: `<oid> <type> <size>\n<content>\n` per
 * object (`<oid> missing` for absent ones). Sizes are bytes, so content is
 * sliced from a Buffer, not the decoded string.
 */
export function parseBatch(stdout: string): string[] {
  const buf = Buffer.from(stdout, 'utf8');
  const blobs: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header.length !== 3) continue; // "<oid> missing"
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || pos + size > buf.length) break;
    if (size <= MAX_INTENT_BLOB_BYTES) blobs.push(buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1; // trailing newline
  }
  return blobs;
}
