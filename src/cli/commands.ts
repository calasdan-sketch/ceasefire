/**
 * CLI command implementations. Each returns a CommandResult; the entry
 * point (src/cli.ts) only handles argv parsing and process exit codes.
 * Keeping commands pure-ish makes them testable without spawning.
 */
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, renameSync, appendFileSync } from 'node:fs';
import { IntentStore, resolveDbPath, resolveStoreDir, openIntentStore } from '../intent/index.js';
import { buildCollisionMatrix, intentCollisions } from '../forecast/forecast.js';
import { relatedTips } from '../forecast/ancestry.js';
import {
  canonicalizePath,
  PathOutsideRepoError,
  MAX_PATTERN_LENGTH,
  fileMatchesClaim,
  pathsOverlap,
  isGlob,
  escapeGlob,
  type MatchOptions,
} from '../forecast/paths.js';
import { forecastWorktrees } from '../forecast/worktrees.js';
import { deepForecast, type DeepRef } from '../forecast/deep.js';
import { regenHint } from '../forecast/generated.js';
import { findGitRoot, currentBranch, listLocalBranches, git, tryGit, CeasefireGitError, beginObjectQuarantine, resolveCommits } from '../forecast/git.js';
import { broadcastIntent, fetchRemoteIntents, pruneIntentRefs } from './sync.js';
import { AUTO_LEASE_TASK } from '../intent/index.js';
import { statSync, utimesSync } from 'node:fs';
import {
  formatBlockedMessage,
  formatClearMessage,
  formatOverrideMessage,
  formatDuration,
  sanitizeDisplay,
  type Contention,
  type CheckReport,
} from './format.js';
import { EXIT_CLEAR, EXIT_ERROR, EXIT_ADVISORY, EXIT_BLOCKED, type Collision, type Intent, type Verdict } from '../types.js';

export interface Ctx {
  cwd: string;
  /** True when --json was passed or CEASEFIRE_JSON=1 is set. */
  json: boolean;
  /**
   * What to do with a path outside the repository: 'error' (default, exit 1)
   * or 'ignore' (drop it — used by the editor hook, where edits outside the
   * repo are simply not ceasefire's business).
   */
  outsideRepo?: 'error' | 'ignore';
}

/**
 * Canonical repo-relative paths for user-supplied files/claims (deduped,
 * order kept). Absolute, Windows, `./`, `..` and cwd-relative forms all
 * reduce to the same string, so two agents naming one file differently
 * still collide.
 */
export function canonicalPaths(
  ctx: Ctx,
  inputs: string[],
  mode: 'files' | 'claims' = 'files',
): { paths: string[]; ignored?: number } | { error: string } {
  const root = findGitRoot(ctx.cwd);
  const match = matchOptions(ctx.cwd, root);
  const out: string[] = [];
  let ignored = 0;
  for (const raw of inputs) {
    if (raw.trim() === '') continue;
    if (raw.length > MAX_PATTERN_LENGTH) return { error: `path longer than ${MAX_PATTERN_LENGTH} characters` };
    let p: string;
    try {
      p = canonicalizePath(raw, ctx.cwd, root, match);
    } catch (e) {
      if (e instanceof PathOutsideRepoError) {
        if (ctx.outsideRepo === 'ignore') continue;
        return { error: `${sanitizeDisplay(raw)} is outside the repository${root ? ` (${sanitizeDisplay(root)})` : ''}` };
      }
      throw e;
    }
    // Git's own directory is never tracked content, and a `**` claim must not be "in contention" with it.
    if (mode === 'files' && (match.ignoreCase ? p.toLowerCase() : p).split('/')[0] === '.git') {
      ignored++;
      continue;
    }
    // A claim naming a real file whose name contains glob metacharacters
    // (Next.js `app/[id]/page.tsx`) is stored escaped, so it stays a literal.
    if (mode === 'claims' && root && isGlob(p) && existsSync(join(root, p))) p = escapeGlob(p);
    if (p && !out.includes(p)) out.push(p);
  }
  return { paths: out, ...(ignored > 0 ? { ignored } : {}) };
}

/** Is this repository on a case-insensitive filesystem? (Windows root, git's core.ignorecase, or a `.GIT` probe.) */
export function repoIgnoresCase(root: string | null): boolean {
  if (!root) return false;
  if (/^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}[^\\/]/.test(root)) return true;
  if (tryGit(root, ['config', '--bool', 'core.ignorecase']) === 'true') return true;
  return existsSync(join(root, '.GIT')) && existsSync(join(root, '.git'));
}

const matchCache = new Map<string, MatchOptions>();

/** Match options for comparisons in this repo (cached per root). */
export function matchOptions(cwd: string, root: string | null = findGitRoot(cwd)): MatchOptions {
  if (!root) return {};
  let m = matchCache.get(root);
  if (!m) {
    m = { ignoreCase: repoIgnoresCase(root) };
    matchCache.set(root, m);
  }
  return m;
}

/** Parse a TTL like `90s`, `30m`, `2h`, `1d`. Bounded to 1 minute .. 7 days. */
export function parseTtl(text: string): number | null {
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(text.trim());
  if (!m) return null;
  const n = parseInt(m[1] as string, 10);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  const ms = n * unit;
  if (ms < 60_000 || ms > 7 * 86_400_000) return null;
  return ms;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

const HOOK_MARKER = '# installed by ceasefire init';
const WORKFLOW_MARKER = '# installed by ceasefire init';

/** True when no agent name was configured, so the name is guessed from the machine. */
export function usesDefaultIdentity(): boolean {
  return !process.env.CEASEFIRE_AGENT?.trim();
}

/**
 * The agent's name: CEASEFIRE_AGENT, else `user@host`. The host part matters: every cloud
 * container and CI runner has the same user ("root", "runner"), and an agent never collides with
 * itself, so before this change two such agents on different machines could never warn each other.
 */
export function currentAgent(): string {
  const fromEnv = process.env.CEASEFIRE_AGENT?.trim();
  if (fromEnv) return fromEnv;
  let user = 'unknown';
  try {
    user = userInfo().username || 'unknown';
  } catch {
    /* no passwd entry (container with an arbitrary uid) */
  }
  let host = '';
  try {
    host = hostname().split('.')[0] ?? '';
  } catch {
    /* no hostname */
  }
  return (host ? `${user}@${host}` : user).slice(0, 120);
}

export function currentBranchName(cwd: string): string {
  const sha = () => {
    const head = tryGit(cwd, ['rev-parse', '--short=8', 'HEAD']);
    return head ? `detached@${head}` : 'unknown';
  };
  return process.env.CEASEFIRE_BRANCH?.trim() || currentBranch(cwd) || sha();
}

function openStore(cwd: string): IntentStore {
  // Resilient open: a corrupt intents.db is quarantined and recreated
  // instead of failing every command (see openIntentStore).
  return openIntentStore(resolveDbPath(cwd));
}

/**
 * Record a CEASEFIRE_ALLOW_CONFLICT=1 override as JSONL in the store dir.
 * Overrides are the telemetry the DX review asked for: they show up as
 * "override rate", the metric for whether strict mode should ever become
 * the default. Best-effort — logging must never break the check itself.
 */
function logOverride(cwd: string, agent: string, files: string[], contentions: Contention[]): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      files,
      holders: [...new Set(contentions.map((c) => c.holder))],
    });
    appendFileSync(join(resolveStoreDir(cwd), 'overrides.log'), line + '\n');
  } catch {
    /* logging is advisory */
  }
}

/**
 * Local active intents plus best-effort remote ones, deduped by id.
 * `fetch: false` reads only already-fetched broadcast refs: no network, and
 * no ref or FETCH_HEAD is written.
 */
export function allActiveIntents(cwd: string, store: IntentStore, now: number, opts: { fetch?: boolean } = {}): Intent[] {
  const local = store.list({ status: 'active', now });
  const seen = new Set(local.map((i) => i.id));
  const merged = [...local];
  for (const remote of fetchRemoteIntents(cwd, { fetch: opts.fetch ?? true })) {
    if (!seen.has(remote.id) && remote.status === 'active' && remote.expiresAt > now) {
      seen.add(remote.id);
      merged.push(remote);
    }
  }
  return merged;
}

function err(message: string): CommandResult {
  return { exitCode: EXIT_ERROR, stdout: '', stderr: `ceasefire: error: ${message}\n` };
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

export function cmdCheck(ctx: Ctx, files: string[], now: number = Date.now(), opts: { claim?: boolean } = {}): CommandResult {
  if (files.length === 0) return err('usage: ceasefire check <file> [<file>...] [--json]');
  // Outside a repository there is no shared ledger to consult. Saying "clear" would be a lie.
  if (ctx.outsideRepo !== 'ignore' && !process.env.CEASEFIRE_DIR?.trim() && !findGitRoot(ctx.cwd)) return err('not a git repository: ceasefire checks files against the intents of this repository.');
  const canon = canonicalPaths(ctx, files);
  if ('error' in canon) return err(canon.error);
  const normalized = canon.paths;
  const match = matchOptions(ctx.cwd);
  if (normalized.length === 0) {
    if (ctx.outsideRepo === 'ignore') return { exitCode: EXIT_CLEAR, stdout: '' };
    if (canon.ignored) {
      const message = 'ceasefire: clear — .git internals are not tracked content; nothing to check.';
      return { exitCode: EXIT_CLEAR, stdout: ctx.json ? JSON.stringify({ verdict: 'clear', files: [], contentions: [], message }, null, 2) + '\n' : message + '\n' };
    }
    return err('usage: ceasefire check <file> [<file>...] [--json]');
  }

  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const contentions: Contention[] = [];
    for (const intent of allActiveIntents(ctx.cwd, store, now)) {
      if (intent.agent === agent) continue; // your own intents never block you
      const overlapping = normalized.filter((f) => intent.paths.some((p) => fileMatchesClaim(f, p, match)));
      if (overlapping.length > 0) {
        contentions.push({
          holder: intent.agent,
          branch: intent.branch,
          intentId: intent.id,
          task: intent.task,
          expiresInMs: intent.expiresAt - now,
          files: overlapping.sort(),
        });
      }
    }

    if (contentions.length === 0) {
      if (opts.claim) claimLease(ctx, normalized, now);
      const message = formatClearMessage(normalized);
      return {
        exitCode: EXIT_CLEAR,
        stdout: ctx.json
          ? JSON.stringify({ verdict: 'clear', files: normalized, contentions: [], message }, null, 2) + '\n'
          : message + '\n',
      };
    }

    if (process.env.CEASEFIRE_ALLOW_CONFLICT === '1') {
      const message = formatOverrideMessage(normalized);
      logOverride(ctx.cwd, agent, normalized, contentions);
      if (opts.claim) claimLease(ctx, normalized, now);
      const report: CheckReport = { verdict: 'clear', files: normalized, contentions, overridden: true, strict: false };
      return {
        exitCode: EXIT_CLEAR,
        stdout: ctx.json
          ? JSON.stringify({ ...report, message }, null, 2) + '\n'
          : message + '\n',
      };
    }

    const strict = process.env.CEASEFIRE_STRICT === '1';
    if (opts.claim && !strict) claimLease(ctx, normalized, now); // advisory: you may proceed, so you hold the files too
    const verdict: Verdict = strict ? 'blocked' : 'advisory';
    const report: CheckReport = { verdict, files: normalized, contentions, overridden: false, strict };
    const message = formatBlockedMessage(report);
    return {
      exitCode: strict ? EXIT_BLOCKED : EXIT_ADVISORY,
      stdout: ctx.json
        ? JSON.stringify({ ...report, message }, null, 2) + '\n'
        : message + '\n',
    };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* auto-lease (editor hook)                                            */
/* ------------------------------------------------------------------ */

/** Default sliding lease: a session that stops editing stops holding files after this long. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export function leaseTtlMs(): number {
  const raw = process.env.CEASEFIRE_LEASE_TTL;
  if (raw) {
    const t = parseTtl(raw);
    if (t !== null) return t;
  }
  return DEFAULT_LEASE_MS;
}

/**
 * Record that this agent is editing `files` (repo-relative, canonical):
 * create or extend its auto-lease. Broadcast to other machines on creation
 * and, at most every CEASEFIRE_LEASE_BROADCAST_S (default 30) seconds, when
 * the lease gains a file, so a busy session does not push once per edit.
 * Never throws: leasing is a courtesy and must not break an edit.
 */
export function claimLease(ctx: Ctx, files: string[], now: number = Date.now()): Intent | null {
  if (files.length === 0) return null;
  let store: IntentStore | null = null;
  try {
    store = openStore(ctx.cwd);
    const agent = currentAgent();
    const branch = currentBranchName(ctx.cwd);
    let last: { intent: Intent; created: boolean; pathAdded: boolean } | null = null;
    let created = false;
    let added = false;
    for (const f of files) {
      last = store.touchLease(f, { agent, branch, ttlMs: leaseTtlMs(), now });
      created ||= last.created;
      added ||= last.pathAdded;
    }
    if (last && (created || added)) {
      const stamp = join(resolveStoreDir(ctx.cwd), `lease-broadcast-${last.intent.id.slice(0, 8)}`);
      const every = Math.max(0, Number(process.env.CEASEFIRE_LEASE_BROADCAST_S ?? '30') || 0) * 1000;
      let due = created;
      if (!due) {
        try {
          due = now - statSync(stamp).mtimeMs >= every;
        } catch {
          due = true;
        }
      }
      if (due) {
        try {
          writeFileSync(stamp, '');
          utimesSync(stamp, new Date(now), new Date(now));
        } catch {
          /* stamp is an optimisation only */
        }
        broadcastIntent(ctx.cwd, last.intent);
      }
    }
    return last?.intent ?? null;
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/** Release this agent's auto-leases (session ended). Returns how many were released. */
export function releaseLeases(ctx: Ctx, now: number = Date.now()): number {
  let store: IntentStore | null = null;
  try {
    store = openStore(ctx.cwd);
    const done = store.completeAll(currentAgent(), { onlyLeases: true, now });
    for (const i of done) broadcastIntent(ctx.cwd, i);
    return done.length;
  } catch {
    return 0;
  } finally {
    store?.close();
  }
}

export { AUTO_LEASE_TASK };

/* ------------------------------------------------------------------ */
/* start / done                                                        */
/* ------------------------------------------------------------------ */

/** A claim this wide is almost never meant: it stops every other agent from working. */
const BROAD_CLAIM_FRACTION = 0.5;
const BROAD_CLAIM_MIN_FILES = 20;

/** Other agents' live intents that overlap `paths`, with the earlier claimant first. */
function contendingIntents(cwd: string, store: IntentStore, paths: string[], mine: Intent, now: number): Array<Contention & { claimedFirst: boolean }> {
  const match = matchOptions(cwd);
  const out: Array<Contention & { claimedFirst: boolean }> = [];
  for (const other of allActiveIntents(cwd, store, now)) {
    if (other.agent === mine.agent || other.id === mine.id) continue;
    const files = [...new Set(paths.filter((f) => other.paths.some((p) => pathsOverlap(f, p, match))))].sort();
    if (files.length === 0) continue;
    out.push({
      holder: other.agent,
      branch: other.branch,
      intentId: other.id,
      task: other.task,
      expiresInMs: other.expiresAt - now,
      files,
      // Same tiebreak for both agents (earlier claim, then lower id), so they converge without negotiating.
      claimedFirst: other.createdAt < mine.createdAt || (other.createdAt === mine.createdAt && other.id < mine.id),
    });
  }
  return out;
}

/** How many tracked files do these claims cover? Null when git cannot say or the repo is small. */
function broadClaim(cwd: string, paths: string[]): { covered: number; total: number } | null {
  const root = findGitRoot(cwd);
  if (!root) return null;
  const listing = tryGit(root, ['ls-files', '-z']);
  if (!listing) return null;
  const files = listing.split('\0').filter(Boolean);
  if (files.length < BROAD_CLAIM_MIN_FILES) return null;
  const match = matchOptions(cwd, root);
  // Big monorepos: look at an even sample of at most 20,000 files and scale the count up.
  const stride = Math.max(1, Math.ceil(files.length / 20_000));
  let hit = 0;
  let seen = 0;
  for (let i = 0; i < files.length; i += stride) {
    seen++;
    if (paths.some((p) => fileMatchesClaim(files[i] as string, p, match))) hit++;
  }
  const covered = stride === 1 ? hit : Math.round((hit / seen) * files.length);
  return covered >= BROAD_CLAIM_MIN_FILES && covered / files.length >= BROAD_CLAIM_FRACTION ? { covered, total: files.length } : null;
}

export function cmdStart(ctx: Ctx, task: string, paths: string[], ttlMs?: number): CommandResult {
  if (!task.trim()) return err('usage: ceasefire start "<task>" --paths <file> [<file>...]');
  const canon = canonicalPaths(ctx, paths, 'claims');
  if ('error' in canon) return err(canon.error);
  const store = openStore(ctx.cwd);
  try {
    const intent = store.publish(task, canon.paths, {
      agent: currentAgent(),
      branch: currentBranchName(ctx.cwd),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
    broadcastIntent(ctx.cwd, intent); // best-effort, never throws
    pruneIntentRefs(ctx.cwd); // best-effort, at most hourly
    const now = Date.now();
    let contested: Array<Contention & { claimedFirst: boolean }> = [];
    let broad: { covered: number; total: number } | null = null;
    try {
      contested = contendingIntents(ctx.cwd, store, canon.paths, intent, now);
      broad = broadClaim(ctx.cwd, canon.paths);
    } catch {
      /* the heads-up is a courtesy; the claim itself is already published */
    }
    const warnings: string[] = [];
    if (broad) warnings.push(`this claim covers ${broad.covered} of ${broad.total} tracked files; other agents will be told to stay away from most of the repository. Claim the directories you will actually edit.`);
    if (usesDefaultIdentity()) warnings.push(`agent name defaulted to "${sanitizeDisplay(intent.agent)}". Agents that share a name never warn each other; set CEASEFIRE_AGENT to a different name per agent.`);
    const line =
      `ceasefire: intent ${intent.id.slice(0, 8)} published by "${sanitizeDisplay(intent.agent)}" on ${sanitizeDisplay(intent.branch)} ` +
      `(expires in ${formatDuration(intent.expiresAt - Date.now())}). Release with \`ceasefire done\`.`;
    const text = [line];
    if (contested.length > 0) {
      text.push(`ceasefire: heads-up — ${contested.length} other intent(s) already hold some of these paths:`);
      for (const c of contested) {
        text.push(
          `  "${sanitizeDisplay(c.holder)}" on ${sanitizeDisplay(c.branch)} (${c.intentId.slice(0, 8)}, "${sanitizeDisplay(c.task)}", expires in ${formatDuration(c.expiresInMs)}): ${c.files.slice(0, 5).map(sanitizeDisplay).join(', ')}${c.files.length > 5 ? ` … +${c.files.length - 5}` : ''}` +
            (c.claimedFirst ? ' — claimed before you' : ' — claimed after you'),
        );
      }
      text.push('  The earlier claim keeps priority. If theirs is earlier, pick other files (`ceasefire suggest`) or coordinate before editing.');
    }
    for (const w of warnings) text.push(`ceasefire: warning — ${w}`);
    return {
      exitCode: EXIT_CLEAR,
      stdout: ctx.json ? JSON.stringify({ intent, contested, warnings }, null, 2) + '\n' : text.join('\n') + '\n',
    };
  } catch (e) {
    return err(e instanceof Error ? e.message.replace(/^ceasefire: /, '') : String(e));
  } finally {
    store.close();
  }
}

export function cmdDone(ctx: Ctx, id?: string, now: number = Date.now(), all = false): CommandResult {
  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const mine = allActiveIntents(ctx.cwd, store, now).filter((i) => i.agent === agent);
    if (all) {
      if (id) return err('--all and --id cannot be combined');
      const finished: Intent[] = [];
      for (const target of mine) {
        if (!store.get(target.id)) store.upsert(target);
        const updated = store.complete(target.id);
        if (updated) {
          broadcastIntent(ctx.cwd, updated);
          finished.push(updated);
        }
      }
      return {
        exitCode: EXIT_CLEAR,
        stdout: ctx.json
          ? JSON.stringify({ completed: finished }, null, 2) + '\n'
          : `ceasefire: completed ${finished.length} intent(s) for "${sanitizeDisplay(agent)}".\n`,
      };
    }
    if (mine.length === 0) {
      return err(`no active intent for agent "${sanitizeDisplay(agent)}" on this machine. Nothing to complete.`);
    }
    let target: Intent;
    if (id) {
      const matches = mine.filter((i) => i.id === id || i.id.startsWith(id));
      if (matches.length === 0) return err(`no active intent for agent "${agent}" matching "${id}".`);
      if (matches.length > 1) {
        const list = matches.map((i) => `  ${i.id.slice(0, 8)}  ${sanitizeDisplay(i.branch)}  "${sanitizeDisplay(i.task)}"`).join('\n');
        return err(
          `"${id}" matches ${matches.length} active intents; be more specific:\n${list}\nUse: ceasefire done --id <id>`,
        );
      }
      const found = matches[0] as Intent;
      target = found;
    } else if (mine.length > 1) {
      const list = mine.map((i) => `  ${i.id.slice(0, 8)}  ${sanitizeDisplay(i.branch)}  "${sanitizeDisplay(i.task)}"`).join('\n');
      return err(
        `agent "${agent}" has ${mine.length} active intents; specify one:\n${list}\nUse: ceasefire done --id <id>`,
      );
    } else {
      const only = mine[0];
      if (!only) return err(`no active intent for agent "${agent}" on this machine. Nothing to complete.`);
      target = only;
    }
    // The intent may live only in a git-refs broadcast from another machine.
    // Import it locally first so the completion sticks and is re-broadcast.
    if (!store.get(target.id)) store.upsert(target);
    const updated = store.complete(target.id);
    if (updated) {
      broadcastIntent(ctx.cwd, updated); // best-effort, never throws
      pruneIntentRefs(ctx.cwd);
    }
    const line = `ceasefire: intent ${target.id.slice(0, 8)} ("${sanitizeDisplay(target.task)}") completed.`;
    return {
      exitCode: EXIT_CLEAR,
      stdout: ctx.json ? JSON.stringify({ completed: updated ?? target }, null, 2) + '\n' : line + '\n',
    };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* conflicts                                                           */
/* ------------------------------------------------------------------ */

export interface ConflictsOptions {
  /** Exit 2 when any collision is found (default: always exit 0, as in v0.1). */
  exitCode?: boolean;
  /** Forecast across `git worktree` checkouts, including uncommitted edits. */
  worktrees?: boolean;
  /** With `worktrees`: also include new, non-ignored files. */
  untracked?: boolean;
  /** Also report files both sides changed that git merges cleanly (severity "overlap"). */
  overlap?: boolean;
  /** Also report removed exports still used by the other side's new code (severity "semantic", confidence high). */
  semantic?: boolean;
  /** Also report import-graph neighbors (severity "semantic", confidence low). */
  neighbors?: boolean;
  /** With `exitCode`: collisions made only of lockfiles/generated files do not count. */
  ignoreRegenerable?: boolean;
}

/** Mark textual collisions made only of lockfiles/generated files as regenerable. */
export function annotateRegenerable(collisions: Collision[]): Collision[] {
  return collisions.map((c) => {
    if (c.severity !== 'textual') return c;
    const hint = regenHint(c.files);
    return hint ? { ...c, regenerable: true, hint } : c;
  });
}

export function cmdConflicts(ctx: Ctx, now: number = Date.now(), opts: ConflictsOptions = {}): CommandResult {
  const root = findGitRoot(ctx.cwd);
  if (!root) return err('not a git repository. `ceasefire conflicts` forecasts branch collisions with git merge-tree.');
  if (opts.untracked && !opts.worktrees) return err('--untracked only applies together with --worktrees');
  let branches: string[] = [];
  let worktrees: Array<{ path: string; branch: string | null; label: string; dirty: boolean }> | undefined;
  const skipped: string[] = [];
  const store = openStore(ctx.cwd);
  let endQuarantine: () => void = () => undefined;
  try {
    // --worktrees promises a read-only run: no fetch (which writes refs/ceasefire/* and FETCH_HEAD).
    const intents = allActiveIntents(ctx.cwd, store, now, { fetch: !opts.worktrees });
    const match = matchOptions(ctx.cwd, root);
    let collisions: Collision[];
    let deepRefs: DeepRef[] = [];
    let related: ((a: string, b: string) => boolean) | undefined;
    // From here on nothing is fetched: merge results and snapshots go to a temp object dir, not the repo.
    endQuarantine = beginObjectQuarantine(ctx.cwd);
    if (opts.worktrees) {
      const wf = forecastWorktrees(ctx.cwd, { includeUntracked: opts.untracked ?? false });
      worktrees = wf.worktrees.map((w) => ({ path: w.path, branch: w.branch, label: w.label, dirty: w.dirty }));
      for (const sk of wf.skipped) skipped.push(`ceasefire: warning — skipped worktree ${sanitizeDisplay(sk.worktree)}: ${sanitizeDisplay(sk.reason)}`);
      if (wf.worktrees.length === 0) {
        return err('no worktree could be snapshotted; nothing was forecast (see warnings).' + (skipped.length ? '\n' + skipped.join('\n') : ''));
      }
      if (wf.worktrees.length < 2) {
        skipped.push('ceasefire: note — only one worktree found; add agents with `git worktree add` to compare their uncommitted work.');
      }
      collisions = [...wf.collisions, ...intentCollisions(intents, now, match)];
      deepRefs = wf.worktrees.map((w) => ({ label: `${w.label} [worktree]`, oid: w.snapshot }));
      related = relatedTips(ctx.cwd, deepRefs.map((d) => d.oid));
    } else {
      try {
        branches = listLocalBranches(ctx.cwd);
      } catch (e) {
        return err(e instanceof CeasefireGitError ? e.stderr : String(e));
      }
      const tipOf = resolveCommits(ctx.cwd, branches);
      related = relatedTips(ctx.cwd, [...tipOf.values()]);
      collisions = buildCollisionMatrix(ctx.cwd, branches, intents, now, (a, b, reason) => {
        skipped.push(`ceasefire: warning — could not forecast ${sanitizeDisplay(a)} <-> ${sanitizeDisplay(b)}: ${sanitizeDisplay(reason)}`);
      }, match, related);
      if (opts.overlap || opts.semantic || opts.neighbors) {
        for (const [label, oid] of tipOf) deepRefs.push({ label, oid });
      }
    }
    if (opts.overlap || opts.semantic || opts.neighbors) {
      const textual = new Map<string, string[]>();
      for (const c of collisions) if (c.severity === 'textual') textual.set(`${c.prA}\0${c.prB}`, c.files);
      const deep = deepForecast(ctx.cwd, deepRefs, {
        overlap: opts.overlap ?? false,
        semantic: opts.semantic ?? false,
        neighbors: opts.neighbors ?? false,
        textual,
        related,
      });
      collisions = [...collisions, ...deep.collisions];
      for (const n of deep.notes) skipped.push(`ceasefire: note — ${sanitizeDisplay(n)}`);
    }
    collisions = annotateRegenerable(collisions);
    const stderr = skipped.length > 0 ? skipped.join('\n') + '\n' : undefined;
    const counted = opts.ignoreRegenerable ? collisions.filter((c) => !c.regenerable) : collisions;
    const exitCode = opts.exitCode && counted.length > 0 ? EXIT_ADVISORY : EXIT_CLEAR;
    const scope = worktrees
      ? `${worktrees.length} worktree(s) (${worktrees.filter((w) => w.dirty).length} with uncommitted changes)`
      : `${branches.length} branch(es)`;
    if (ctx.json) {
      return {
        exitCode,
        stdout:
          JSON.stringify(
            {
              ...(worktrees ? { worktrees } : { branches }),
              collisionCount: collisions.length,
              collisions,
              generatedAt: now,
            },
            null,
            2,
          ) + '\n',
        ...(stderr !== undefined ? { stderr } : {}),
      };
    }
    if (collisions.length === 0) {
      return {
        exitCode,
        stdout: `ceasefire: no collisions across ${scope}.\n`,
        ...(stderr !== undefined ? { stderr } : {}),
      };
    }
    const lines = [
      `ceasefire: ${collisions.length} collision(s) across ${scope}:`,
      ...collisions.map(
        (c) =>
          `  [${c.severity.toUpperCase()}${c.confidence ? `, ${c.confidence} confidence` : ''}${c.regenerable ? ', regenerable' : ''}] ${sanitizeDisplay(c.prA)} <-> ${sanitizeDisplay(c.prB)}\n` +
          `      files: ${c.files.map(sanitizeDisplay).join(', ')}` +
          (c.detail ? `\n      ${sanitizeDisplay(c.detail)}` : '') +
          (c.yields ? `\n      claimed first keeps the files; ${sanitizeDisplay(c.yields)} should step aside` : '') +
          (c.hint ? `\n      fix: ${sanitizeDisplay(c.hint)}` : ''),
      ),
    ];
    return { exitCode, stdout: lines.join('\n') + '\n', ...(stderr !== undefined ? { stderr } : {}) };
  } catch (e) {
    return err(e instanceof CeasefireGitError ? e.stderr : String(e));
  } finally {
    endQuarantine();
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

/** Active intents (local + broadcast), oldest first. */
export function cmdList(ctx: Ctx, now: number = Date.now()): CommandResult {
  const store = openStore(ctx.cwd);
  try {
    const intents = allActiveIntents(ctx.cwd, store, now).sort((a, b) => a.createdAt - b.createdAt);
    if (ctx.json) {
      return { exitCode: EXIT_CLEAR, stdout: JSON.stringify({ intents, generatedAt: now }, null, 2) + '\n' };
    }
    if (intents.length === 0) return { exitCode: EXIT_CLEAR, stdout: 'ceasefire: no active intents.\n' };
    const me = currentAgent();
    const lines = [`ceasefire: ${intents.length} active intent(s):`];
    for (const i of intents) {
      lines.push(
        `  ${i.id.slice(0, 8)}  "${sanitizeDisplay(i.agent)}"${i.agent === me ? ' (you)' : ''} on ${sanitizeDisplay(i.branch)}` +
          ` — "${sanitizeDisplay(i.task)}" (expires in ${formatDuration(i.expiresAt - now)})`,
      );
      for (const p of i.paths.slice(0, 20)) lines.push(`      ${sanitizeDisplay(p)}`);
      if (i.paths.length > 20) lines.push(`      … and ${i.paths.length - 20} more`);
    }
    return { exitCode: EXIT_CLEAR, stdout: lines.join('\n') + '\n' };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

/**
 * Who is editing what, right now. Reads the local ledger plus intent refs
 * already fetched (no network, no writes), so it is cheap enough to back a
 * status line that refreshes every few seconds.
 */
export function cmdStatus(ctx: Ctx, opts: { oneline?: boolean } = {}, now: number = Date.now()): CommandResult {
  if (!findGitRoot(ctx.cwd)) return err('not a git repository.');
  const store = openStore(ctx.cwd);
  try {
    const intents = allActiveIntents(ctx.cwd, store, now, { fetch: false });
    const match = matchOptions(ctx.cwd);
    const contested = intentCollisions(intents, now, match);
    const agents = new Map<string, Intent[]>();
    for (const i of intents) agents.set(i.agent, [...(agents.get(i.agent) ?? []), i]);
    const held = new Set(intents.flatMap((i) => i.paths));
    const contestedFiles = [...new Set(contested.flatMap((c) => c.files))].sort();
    const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
    const headline =
      agents.size === 0
        ? 'ceasefire: idle (no agent holds any file)'
        : `ceasefire: ${plural(agents.size, 'agent')} editing, ${plural(held.size, 'path')} held` +
          (contestedFiles.length > 0 ? `, ${plural(contestedFiles.length, 'file')} CONTESTED` : '');
    if (opts.oneline) return { exitCode: EXIT_CLEAR, stdout: headline + '\n' };
    if (ctx.json) {
      return {
        exitCode: EXIT_CLEAR,
        stdout:
          JSON.stringify(
            {
              agents: [...agents.entries()].map(([agent, list]) => ({
                agent,
                branches: [...new Set(list.map((i) => i.branch))],
                paths: [...new Set(list.flatMap((i) => i.paths))],
                expiresInMs: Math.max(...list.map((i) => i.expiresAt - now)),
              })),
              contested: contested,
              generatedAt: now,
            },
            null,
            2,
          ) + '\n',
      };
    }
    const lines = [headline];
    for (const [agent, list] of agents) {
      const paths = [...new Set(list.flatMap((i) => i.paths))];
      const left = Math.max(...list.map((i) => i.expiresAt - now));
      lines.push(
        `  ${sanitizeDisplay(agent)}${agent === currentAgent() ? ' (you)' : ''} on ${[...new Set(list.map((i) => sanitizeDisplay(i.branch)))].join(', ')}` +
          ` — ${plural(paths.length, 'path')}, lease ends in ${formatDuration(left)}`,
      );
      for (const p of paths.slice(0, 6)) lines.push(`      ${sanitizeDisplay(p)}`);
      if (paths.length > 6) lines.push(`      … and ${paths.length - 6} more`);
    }
    if (contested.length > 0) {
      lines.push('', 'Contested (two agents hold the same paths):');
      for (const c of contested) lines.push(`  ${sanitizeDisplay(c.prA)} <-> ${sanitizeDisplay(c.prB)}: ${c.files.map(sanitizeDisplay).join(', ')}`);
    }
    return { exitCode: EXIT_CLEAR, stdout: lines.join('\n') + '\n' };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* suggest                                                             */
/* ------------------------------------------------------------------ */

/** Tracked files nobody holds an active intent on (capped). Never throws. */
function unclaimedFiles(cwd: string, intents: Intent[], limit = 15): string[] {
  const root = findGitRoot(cwd);
  if (!root) return [];
  let tracked: string[];
  try {
    tracked = git(cwd, ['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const claimed = intents.filter((i) => i.status === 'active');
  const match = matchOptions(cwd, root);
  return tracked
    .filter((f) => !claimed.some((i) => i.paths.some((p) => fileMatchesClaim(f, p, match))))
    .slice(0, limit);
}

export function cmdSuggest(ctx: Ctx, files: string[], now: number = Date.now()): CommandResult {
  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const intents = allActiveIntents(ctx.cwd, store, now).filter((i) => i.agent !== agent);
    const canon = canonicalPaths(ctx, files);
    if ('error' in canon) return err(canon.error);
    const normalized = canon.paths;
    const holders = new Map<string, { holder: string; task: string }>();
    for (const f of normalized) {
      for (const intent of intents) {
        if (intent.paths.some((p) => fileMatchesClaim(f, p, matchOptions(ctx.cwd)))) {
          holders.set(f, { holder: intent.agent, task: intent.task });
        }
      }
    }
    const alternatives = unclaimedFiles(ctx.cwd, intents);

    if (ctx.json) {
      return {
        exitCode: EXIT_CLEAR,
        stdout:
          JSON.stringify(
            {
              blockedFiles: [...holders.entries()].map(([file, h]) => ({ file, ...h })),
              alternatives,
            },
            null,
            2,
          ) + '\n',
      };
    }

    const lines: string[] = [];
    if (holders.size === 0) {
      lines.push(
        normalized.length > 0
          ? 'ceasefire suggest: nothing holds those files — proceed with `ceasefire check` to confirm.'
          : 'ceasefire suggest: no active intents from other agents right now.',
      );
    } else {
      lines.push('ceasefire suggest: these files are held by other agents — work around them:');
      for (const [file, h] of holders) {
        lines.push(`  - ${sanitizeDisplay(file)}  (held by "${sanitizeDisplay(h.holder)}" — "${sanitizeDisplay(h.task)}")`);
      }
    }
    if (alternatives.length > 0) {
      lines.push('');
      lines.push('Productive alternatives nobody has claimed:');
      for (const a of alternatives) lines.push(`  - ${sanitizeDisplay(a)}`);
    } else if (holders.size > 0) {
      lines.push('');
      lines.push('No unclaimed tracked files found; coordinate with the holders above or wait for `ceasefire done`.');
    }
    return { exitCode: EXIT_CLEAR, stdout: lines.join('\n') + '\n' };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

const PRE_PUSH_HOOK = `#!/bin/sh
${HOOK_MARKER} — advisory only, never blocks a push.
# Runs a collision forecast before push. Best-effort: if ceasefire is missing
# or the forecast fails, the push continues.
#
# Skips ceasefire's own intent-broadcast pushes (refs/ceasefire/*): every
# \`ceasefire start\`/\`ceasefire done\` pushes an intent ref, and forecasting the
# whole repo on each of those would be pure overhead.
seen=0
only_ceasefire=1
while read -r _ _ remote _; do
  seen=1
  case "$remote" in
    refs/ceasefire/*) ;;
    *) only_ceasefire=0; break ;;
  esac
done
if [ "$seen" = 1 ] && [ "$only_ceasefire" = 1 ]; then
  exit 0
fi
if command -v ceasefire >/dev/null 2>&1; then
  if out=$(ceasefire conflicts 2>/dev/null); then
    case "$out" in
      *'collision(s)'*)
        printf 'ceasefire: pre-push collision forecast (advisory — push continues)\\n%s\\n' "$out" >&2
        ;;
    esac
  else
    printf 'ceasefire: collision forecast failed (advisory — push continues)\\n' >&2
  fi
fi
exit 0
`;

const WORKFLOW_STUB = `${WORKFLOW_MARKER}: advisory collision forecast (full PR comments by the ceasefire GitHub Action)
name: ceasefire
on:
  pull_request:
jobs:
  forecast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx ceasefire@latest conflicts --json
`;

/** The PreToolUse entry `ceasefire init --claude` adds to .claude/settings.json. */
export const CLAUDE_HOOK_COMMAND = 'ceasefire hook claude';
/** SessionEnd entry: releases the session's auto-leases at once. */
export const CLAUDE_RELEASE_COMMAND = 'ceasefire hook release';
/** Status line command (opt-in: `ceasefire init --claude --statusline`). */
export const CLAUDE_STATUSLINE_COMMAND = 'ceasefire status --oneline';

/**
 * Merge ceasefire's PreToolUse hook into <root>/.claude/settings.json.
 * Never clobbers: an unparseable or oddly-shaped settings file is left
 * untouched and reported; an existing ceasefire entry is not duplicated.
 */
export function installClaudeHook(root: string, opts: { strict?: boolean; statusline?: boolean } = {}): { ok: boolean; note: string } {
  const dir = join(root, '.claude');
  const file = join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, note: `.claude/settings.json is not a JSON object; left untouched — add the hook by hand (see README)` };
    }
  }
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return { ok: false, note: '.claude/settings.json has a non-object "hooks" key; left untouched' };
  }
  const pre = (hooks['PreToolUse'] ?? []) as unknown;
  if (!Array.isArray(pre)) return { ok: false, note: '.claude/settings.json "hooks.PreToolUse" is not an array; left untouched' };
  const already = JSON.stringify(pre).includes(CLAUDE_HOOK_COMMAND);
  const extras: string[] = [];
  let changed = !already;
  if (!already) pre.push({
    matcher: 'Write|Edit|MultiEdit|NotebookEdit',
    hooks: [
      opts.strict
        ? // onFailure "block": a hook that crashes, times out or is missing from
          // PATH denies the edit instead of letting it through (Claude Code >= v2.1.295).
          { type: 'command', command: `${CLAUDE_HOOK_COMMAND} --strict --claim`, timeout: 30, onFailure: 'block' }
        : { type: 'command', command: `${CLAUDE_HOOK_COMMAND} --claim`, timeout: 30 },
    ],
  });
  hooks['PreToolUse'] = pre;
  const end = (hooks['SessionEnd'] ?? []) as unknown;
  if (Array.isArray(end) && !JSON.stringify(end).includes(CLAUDE_RELEASE_COMMAND)) {
    end.push({ hooks: [{ type: 'command', command: CLAUDE_RELEASE_COMMAND, timeout: 10 }] });
    hooks['SessionEnd'] = end;
    extras.push('SessionEnd release hook');
    changed = true;
  }
  if (opts.statusline) {
    if (settings['statusLine'] === undefined) {
      settings['statusLine'] = { type: 'command', command: CLAUDE_STATUSLINE_COMMAND };
      extras.push('status line');
      changed = true;
    } else if (!JSON.stringify(settings['statusLine']).includes(CLAUDE_STATUSLINE_COMMAND)) {
      extras.push('status line left alone (you already have one)');
    }
  }
  settings['hooks'] = hooks;
  if (!changed) return { ok: true, note: `Claude Code hook already present in .claude/settings.json${extras.length ? ` (${extras.join('; ')})` : ''}` };
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.ceasefire-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
  return {
    ok: true,
    note:
      `Claude Code PreToolUse hook (${opts.strict ? 'strict, onFailure "block", needs Claude Code >= v2.1.295' : 'advisory'}, auto-lease on) ` +
      `added to .claude/settings.json${extras.length ? ` with ${extras.join(' + ')}` : ''} (needs \`ceasefire\` on PATH: npm i -g ceasefire)`,
  };
}

export function cmdInit(ctx: Ctx, opts: { claude?: boolean; strict?: boolean; statusline?: boolean } = {}): CommandResult {
  const root = findGitRoot(ctx.cwd);
  if (!root) return err('not a git repository. Run `ceasefire init` inside a git checkout.');
  let gitDir: string;
  try {
    gitDir = git(ctx.cwd, ['rev-parse', '--absolute-git-dir']);
  } catch (e) {
    return err(e instanceof CeasefireGitError ? e.stderr : String(e));
  }

  const notes: string[] = [];

  // Pre-push hook (advisory, never blocks).
  const hookPath = join(gitDir, 'hooks', 'pre-push');
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER)) {
      const backup = `${hookPath}.ceasefire-backup`;
      renameSync(hookPath, backup);
      notes.push(`existing pre-push hook backed up to ${backup}`);
    } else {
      notes.push('pre-push hook already installed by ceasefire; refreshed');
    }
  }
  writeFileSync(hookPath, PRE_PUSH_HOOK, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  notes.push(`pre-push hook installed at ${hookPath} (advisory only, never blocks)`);

  // GitHub workflow stub.
  const wfPath = join(root, '.github', 'workflows', 'ceasefire.yml');
  if (existsSync(wfPath)) {
    const existing = readFileSync(wfPath, 'utf8');
    notes.push(
      existing.includes(WORKFLOW_MARKER)
        ? 'workflow stub already present; left untouched'
        : 'workflow ceasefire.yml already exists and was not created by ceasefire; left untouched',
    );
  } else {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(wfPath, WORKFLOW_STUB);
    notes.push(`workflow stub written to ${wfPath}`);
  }

  // The intent DB is local agent state (plus WAL sidecars) — it must never
  // be committed. Ignore the whole .ceasefire/ dir.
  const giPath = join(root, '.gitignore');
  const giLine = '.ceasefire/';
  if (existsSync(giPath)) {
    const lines = readFileSync(giPath, 'utf8').split('\n').map((l) => l.trim());
    if (!lines.includes(giLine) && !lines.includes('.ceasefire')) {
      appendFileSync(giPath, `\n${giLine}\n`);
      notes.push('added .ceasefire/ to .gitignore (intent DB is local state, never committed)');
    } else {
      notes.push('.gitignore already covers .ceasefire/');
    }
  } else {
    writeFileSync(giPath, `${giLine}\n`);
    notes.push('created .gitignore ignoring .ceasefire/ (intent DB is local state, never committed)');
  }

  if (opts.claude) notes.push(installClaudeHook(root, { strict: opts.strict ?? false, statusline: opts.statusline ?? false }).note);

  notes.push('agents: add `ceasefire check <files>` before editing shared files (1 line in AGENTS.md)');
  const body = notes.map((n) => `  - ${n}`).join('\n');
  return {
    exitCode: EXIT_CLEAR,
    stdout: ctx.json
      ? JSON.stringify({ initialized: true, notes }, null, 2) + '\n'
      : `ceasefire: initialized in ${root}\n${body}\n`,
  };
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

function onPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const e of exts) if (existsSync(join(dir, bin + e))) return true;
  }
  return false;
}

/** `ceasefire doctor`: is this machine set up so that agents actually warn each other? */
export function cmdDoctor(ctx: Ctx, now: number = Date.now()): CommandResult {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string): void => {
    checks.push({ name, status, detail });
  };
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number) as [number, number];
  if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)) add('node', 'ok', `Node ${process.versions.node}`);
  else add('node', 'fail', `Node ${process.versions.node}; ceasefire needs >= 22.13 for node:sqlite`);

  const gv = tryGit(ctx.cwd, ['--version']);
  const gm = gv ? /git version (\d+)\.(\d+)/.exec(gv) : null;
  if (!gm) add('git', 'fail', 'git was not found on PATH');
  else {
    const v = Number(gm[1]) * 100 + Number(gm[2]);
    if (v >= 240) add('git', 'ok', `${gv}: branch forecast, worktree forecast and batched merges all available`);
    else if (v >= 238) add('git', 'warn', `${gv}: works, but 2.40+ batches merges (up to 12x faster on many branches)`);
    else add('git', 'warn', `${gv}: worktree forecast needs 2.38+; branch forecast uses the legacy parser`);
  }

  const root = findGitRoot(ctx.cwd);
  if (!root) {
    add('repository', 'fail', 'not inside a git repository');
  } else {
    add('repository', 'ok', sanitizeDisplay(root));
    try {
      const store = openStore(ctx.cwd);
      try {
        const n = store.list({ status: 'active', now }).length;
        add('ledger', 'ok', `${sanitizeDisplay(resolveStoreDir(ctx.cwd))} is writable; ${n} active local intent(s)`);
      } finally {
        store.close();
      }
    } catch (e) {
      add('ledger', 'fail', `cannot open the intent ledger: ${sanitizeDisplay(e instanceof Error ? e.message : String(e))}`);
    }
    if (usesDefaultIdentity()) add('identity', 'warn', `CEASEFIRE_AGENT is not set; this agent is "${sanitizeDisplay(currentAgent())}". Two agents with the same name never warn each other.`);
    else add('identity', 'ok', `agent "${sanitizeDisplay(currentAgent())}"`);

    const settingsFile = join(root, '.claude', 'settings.json');
    let hookText = '';
    try {
      hookText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '';
    } catch {
      /* unreadable settings are reported below as "not installed" */
    }
    if (hookText.includes(CLAUDE_HOOK_COMMAND)) {
      add('claude hook', 'ok', `PreToolUse hook installed${hookText.includes('--strict') ? ' (strict)' : ' (advisory)'}${hookText.includes(CLAUDE_RELEASE_COMMAND) ? ', SessionEnd release hook installed' : '; SessionEnd release hook missing (run `ceasefire init --claude`)'}`);
      if (!onPath('ceasefire')) add('PATH', 'warn', '`ceasefire` is not on PATH, so the Claude Code hook cannot run it; install globally (npm i -g) or edit the hook command');
    } else add('claude hook', 'warn', 'not installed (run `ceasefire init --claude`); other agents only see claims made by `ceasefire start`/`check --claim`');

    const gitDir = tryGit(ctx.cwd, ['rev-parse', '--absolute-git-dir']);
    const pre = gitDir ? join(gitDir, 'hooks', 'pre-push') : '';
    let preInstalled = false;
    try {
      preInstalled = pre !== '' && existsSync(pre) && readFileSync(pre, 'utf8').includes(HOOK_MARKER);
    } catch {
      /* unreadable hook: reported as not installed */
    }
    if (preInstalled) add('pre-push hook', 'ok', 'installed (advisory)');
    else add('pre-push hook', 'warn', 'not installed (run `ceasefire init`)');

    if (process.env.CEASEFIRE_SYNC === '0') add('cross-machine sync', 'warn', 'disabled by CEASEFIRE_SYNC=0');
    else if (!tryGit(ctx.cwd, ['remote', 'get-url', 'origin'])) add('cross-machine sync', 'warn', 'no remote named origin; intents are shared between worktrees of this clone only');
    else {
      const refs = (tryGit(ctx.cwd, ['for-each-ref', '--format=%(refname)', 'refs/ceasefire/intents/']) ?? '').split('\n').filter(Boolean).length;
      add('cross-machine sync', 'ok', `origin configured; ${refs} intent ref(s) known locally (finished ones are pruned hourly)`);
    }
  }

  const failed = checks.some((c) => c.status === 'fail');
  if (ctx.json) return { exitCode: failed ? EXIT_ERROR : EXIT_CLEAR, stdout: JSON.stringify({ ok: !failed, checks }, null, 2) + '\n' };
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  const lines = checks.map((c) => `  [${mark[c.status]}] ${c.name}: ${c.detail}`);
  return { exitCode: failed ? EXIT_ERROR : EXIT_CLEAR, stdout: `ceasefire doctor:\n${lines.join('\n')}\n` };
}
