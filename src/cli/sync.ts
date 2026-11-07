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

/** Upper bound on intents kept per read (newest active first) — bounds a flooding peer. */
const MAX_REMOTE_INTENTS = 500;
/** Upper bound on intent refs inspected per read. Stale refs are pruned, so this is far above normal use. */
const MAX_REF_SCAN = 5000;
/** The longest lifetime `ceasefire start --ttl` allows; a broadcast claiming more is not from ceasefire. */
const MAX_INTENT_LIFETIME_MS = 7 * 86_400_000;
/** Clock-skew allowance between machines. */
const CLOCK_SKEW_MS = 86_400_000;
/** An expired or finished intent ref is deleted once it has been dead this long. */
const PRUNE_GRACE_MS = 86_400_000;
/** Upper bound on a single intent blob — the local DB must not bloat. */
const MAX_INTENT_BLOB_BYTES = 64 * 1024;
/** What another machine will accept (see isValidRemoteIntent); `start` warns when a claim exceeds it. */
export const MAX_REMOTE_TASK_CHARS = 10_000;
export const MAX_REMOTE_PATHS = 1000;
export const MAX_REMOTE_BLOB_BYTES = MAX_INTENT_BLOB_BYTES;
/** Intent ids travel inside git ref names; keep them ref-safe. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function syncEnabled(cwd: string): boolean {
  if (process.env.CEASEFIRE_SYNC === '0') return false;
  return findGitRoot(cwd) !== null && hasRemote(cwd);
}

/**
 * Validate a remotely-broadcast intent before it touches the local store.
 * Broadcasts are self-asserted (anyone with push access can plant one), so
 * the shape is checked strictly: wrong types, oversized blobs, or ref-
 * unsafe ids are dropped, never imported.
 */
export function isValidRemoteIntent(parsed: unknown, now: number = Date.now()): parsed is Intent {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !SAFE_ID_RE.test(p['id'])) return false;
  if (typeof p['agent'] !== 'string' || typeof p['task'] !== 'string' || typeof p['branch'] !== 'string') {
    return false;
  }
  if (!Array.isArray(p['paths']) || !p['paths'].every((x) => typeof x === 'string')) return false;
  if (!Number.isFinite(p['createdAt']) || !Number.isFinite(p['expiresAt'])) return false;
  if (p['status'] !== 'active' && p['status'] !== 'done' && p['status'] !== 'expired') return false;
  // A planted claim that never expires would hold files for every agent, and under strict mode block their
  // edits, forever. ceasefire itself never publishes more than 7 days; a day of clock skew is tolerated, because
  // dropping a real peer's intents silently is worse than holding a forged one for a day.
  if ((p['expiresAt'] as number) > now + MAX_INTENT_LIFETIME_MS + CLOCK_SKEW_MS) return false;
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
    // A finished intent records when it finished, so pruning can leave it up long enough for peers to learn it is done.
    const sent = intent.status !== 'active' && intent.completedAt === undefined ? { ...intent, completedAt: Date.now() } : intent;
    const blob = gitWithStdin(cwd, ['hash-object', '-w', '--stdin'], JSON.stringify(sent));
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
export function fetchRemoteIntents(cwd: string, opts: { fetch?: boolean; now?: number } = {}): Intent[] {
  if (!syncEnabled(cwd)) return [];
  try {
    if (opts.fetch ?? true) maybeFetch(cwd);
    return readIntentRefs(cwd, opts.now ?? Date.now()).intents;
  } catch {
    return [];
  }
}

interface RefScan {
  intents: Intent[];
  /** Refs that are safe to delete: dead for over a day, malformed, oversized or not a blob. */
  stale: string[];
}

function readIntentRefs(cwd: string, now: number): RefScan {
  const listing = tryGit(cwd, ['for-each-ref', '--format=%(refname) %(objectname) %(objecttype) %(objectsize)', REF_PREFIX]);
  if (!listing) return { intents: [], stale: [] };
  const stale: string[] = [];
  const wanted: Array<{ ref: string; oid: string }> = [];
  for (const line of listing.split('\n').slice(0, MAX_REF_SCAN)) {
    const [ref, oid, type, size] = line.trim().split(' ');
    if (!ref || !oid || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
    if (type !== 'blob' || Number(size) > MAX_INTENT_BLOB_BYTES) {
      stale.push(ref); // never even read oversized blobs
      continue;
    }
    wanted.push({ ref, oid });
  }
  if (wanted.length === 0) return { intents: [], stale };
  const out = gitResult(cwd, ['cat-file', '--batch'], { input: wanted.map((w) => w.oid).join('\n') + '\n' });
  if (out.exitCode !== 0) return { intents: [], stale };
  const blobs = parseBatch(out.stdout);
  const intents: Intent[] = [];
  // parseBatch skips "missing" headers, so only trust the pairing when every blob came back.
  const paired = blobs.length === wanted.length;
  blobs.forEach((blob, k) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      if (paired) stale.push((wanted[k] as { ref: string }).ref);
      return;
    }
    if (!isValidRemoteIntent(parsed, now)) {
      if (paired) stale.push((wanted[k] as { ref: string }).ref);
      return;
    }
    const finishedAt = typeof (parsed as { completedAt?: unknown }).completedAt === 'number' ? (parsed as { completedAt: number }).completedAt : parsed.createdAt;
    const dead = (parsed.status !== 'active' && finishedAt < now - PRUNE_GRACE_MS) || parsed.expiresAt < now - PRUNE_GRACE_MS;
    if (paired && dead) stale.push((wanted[k] as { ref: string }).ref);
    intents.push(parsed);
  });
  // Newest live claims first: a flood of old or planted refs must not push real intents past the cap.
  const live = (i: Intent): number => (i.status === 'active' && i.expiresAt > now ? 1 : 0);
  intents.sort((x, y) => live(y) - live(x) || y.createdAt - x.createdAt);
  return { intents: intents.slice(0, MAX_REMOTE_INTENTS), stale };
}

/**
 * Delete intent refs that nothing needs any more, locally and on origin, at most once per
 * PRUNE_INTERVAL. Without this, every `ceasefire start` leaves a ref behind forever, the
 * list grows without bound, and the oldest 500 names hid the newest. Only refs in
 * refs/ceasefire/intents/ are touched, and only ones that are finished, long expired,
 * malformed or oversized. Best-effort: never throws.
 */
export function pruneIntentRefs(cwd: string, now: number = Date.now()): number {
  try {
    if (process.env.CEASEFIRE_SYNC === '0' || findGitRoot(cwd) === null) return 0;
    const stamp = stampPath(cwd)?.replace(/ceasefire-last-fetch$/, 'ceasefire-last-prune') ?? null;
    if (stamp) {
      try {
        if (now - statSync(stamp).mtimeMs < PRUNE_INTERVAL_MS) return 0;
      } catch {
        /* never pruned */
      }
      try {
        writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
      } catch {
        /* read-only git dir: prune every time, still cheap */
      }
    }
    const { stale } = readIntentRefs(cwd, now);
    const refs = [...new Set(stale)].filter((r) => r.startsWith(REF_PREFIX)).slice(0, 200);
    if (refs.length === 0) return 0;
    gitResult(cwd, ['update-ref', '--stdin'], { input: refs.map((r) => `delete ${r}\n`).join('') });
    if (hasRemote(cwd)) {
      tryGit(cwd, ['push', '--quiet', 'origin', '--delete', ...refs], { env: NETWORK_ENV, timeoutMs: fetchTimeoutMs() });
    }
    return refs.length;
  } catch {
    return 0;
  }
}

const PRUNE_INTERVAL_MS = 3_600_000;

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
