/**
 * Worktree forecast: collisions between the *uncommitted* work of agents
 * running in separate `git worktree` checkouts.
 *
 * Branch forecasting (`ceasefire conflicts`) only sees commits. Agents in
 * worktrees often hold minutes or hours of unsaved-to-history edits, and
 * that is exactly when a heads-up is cheapest. For each worktree we build a
 * throwaway snapshot commit of its current state:
 *
 *   1. copy that worktree's index to a temp file (keeps git's stat cache,
 *      so unchanged files are not re-hashed; staged changes are included)
 *   2. `git add -u` (tracked edits and deletions) — or `-A` with
 *      `includeUntracked`, which also picks up new, non-ignored files
 *   3. `git write-tree` + `git commit-tree -p HEAD`
 *
 * then run the same `git merge-tree --write-tree` engine pairwise. Nothing
 * is checked out, no ref is created or moved, and the worktrees' real
 * indexes are never written. Snapshot objects are unreferenced and are
 * removed by git's normal garbage collection.
 *
 * Privacy note: with `includeUntracked`, the content of new non-ignored
 * files is written into the shared object store as loose objects (never
 * pushed — nothing references them). Keep secrets in .gitignore.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitResult, CeasefireGitError } from './git.js';
import { gitSupportsWriteTree, mergeTreeConflictedFilesMany } from './forecast.js';
import type { Collision } from '../types.js';

export interface WorktreeInfo {
  path: string;
  /** Commit HEAD points at; null for an unborn branch. */
  head: string | null;
  /** Short branch name, or null when detached. */
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

export interface WorktreeSnapshot extends WorktreeInfo {
  /** Display label: branch name, or `detached@<sha8>`. */
  label: string;
  /** Snapshot commit (equals head when the worktree is clean). */
  snapshot: string;
  /** True when the worktree has uncommitted changes. */
  dirty: boolean;
}

export interface WorktreeForecast {
  worktrees: WorktreeSnapshot[];
  collisions: Collision[];
  skipped: Array<{ worktree: string; reason: string }>;
}

/** Hard cap on worktrees forecast in one run (pairs grow quadratically). */
export const MAX_WORKTREES = 64;

/** Parse `git worktree list --porcelain -z`. */
export function parseWorktreeList(out: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: field.slice(9), head: null, branch: null, bare: false, prunable: false };
    } else if (cur) {
      if (field.startsWith('HEAD ')) {
        const sha = field.slice(5);
        cur.head = /^0+$/.test(sha) ? null : sha;
      } else if (field.startsWith('branch ')) {
        cur.branch = field.slice(7).replace(/^refs\/heads\//, '');
      } else if (field === 'bare') {
        cur.bare = true;
      } else if (field === 'prunable' || field.startsWith('prunable ')) {
        cur.prunable = true;
      }
    }
  }
  if (cur) list.push(cur);
  return list;
}

export function listWorktrees(cwd: string): WorktreeInfo[] {
  return parseWorktreeList(gitResultOrThrow(cwd, ['worktree', 'list', '--porcelain', '-z']));
}

function gitResultOrThrow(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = gitResult(cwd, args, env !== undefined ? { env } : {});
  if (r.exitCode !== 0) {
    throw new CeasefireGitError(args.join(' '), r.stderr.trim() || r.stdout.trim() || 'unknown error');
  }
  return r.stdout.trim();
}

/** Fixed identity so snapshotting works without user.name/user.email configured. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'ceasefire',
  GIT_AUTHOR_EMAIL: 'ceasefire@localhost',
  GIT_COMMITTER_NAME: 'ceasefire',
  GIT_COMMITTER_EMAIL: 'ceasefire@localhost',
};

/** Build a snapshot commit of a worktree's current state. Throws on failure. */
export function snapshotWorktree(wt: WorktreeInfo, includeUntracked = false): WorktreeSnapshot {
  const label = wt.branch ?? (wt.head ? `detached@${wt.head.slice(0, 8)}` : 'unborn');
  if (!wt.head) throw new CeasefireGitError('snapshot', `worktree ${wt.path} has no commits yet (unborn branch)`);
  if (!existsSync(wt.path)) throw new CeasefireGitError('snapshot', `worktree ${wt.path} is missing on disk`);
  const dir = mkdtempSync(join(tmpdir(), 'ceasefire-snap-'));
  try {
    const tmpIndex = join(dir, 'index');
    const realIndex = gitResultOrThrow(wt.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    // gitResult strips inherited GIT_DIR / GIT_INDEX_FILE / … from every call
    // (including the rev-parse above); only our own temp index is set here.
    const env: NodeJS.ProcessEnv = { ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: tmpIndex };
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    else gitResultOrThrow(wt.path, ['read-tree', wt.head], env);
    // gc.auto=0 / maintenance.auto=false: a forecast must never trigger repo maintenance.
    gitResultOrThrow(wt.path, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'add', includeUntracked ? '-A' : '-u', '--', ':/'], env);
    const tree = gitResultOrThrow(wt.path, ['write-tree'], env);
    const headTree = git(wt.path, ['rev-parse', `${wt.head}^{tree}`]);
    if (tree === headTree) return { ...wt, label, snapshot: wt.head, dirty: false };
    const commit = gitResultOrThrow(
      wt.path,
      ['commit-tree', tree, '-p', wt.head, '-m', 'ceasefire worktree snapshot (unreferenced)'],
      env,
    );
    return { ...wt, label, snapshot: commit, dirty: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pairwise collision forecast across all worktrees of the repository,
 * including uncommitted changes. Requires git >= 2.38.
 */
export function forecastWorktrees(cwd: string, opts: { includeUntracked?: boolean } = {}): WorktreeForecast {
  if (!gitSupportsWriteTree(cwd)) {
    throw new CeasefireGitError(
      'merge-tree --write-tree',
      'worktree forecasting needs git >= 2.38 (`git merge-tree --write-tree`); upgrade git or use `ceasefire conflicts` on branches',
    );
  }
  const skipped: WorktreeForecast['skipped'] = [];
  const all = listWorktrees(cwd).filter((w) => !w.bare);
  if (all.length > MAX_WORKTREES) {
    for (const w of all.slice(MAX_WORKTREES)) skipped.push({ worktree: w.path, reason: `over the ${MAX_WORKTREES}-worktree cap` });
  }
  const snapshots: WorktreeSnapshot[] = [];
  for (const wt of all.slice(0, MAX_WORKTREES)) {
    if (wt.prunable) {
      skipped.push({ worktree: wt.path, reason: 'prunable (directory missing); run `git worktree prune`' });
      continue;
    }
    try {
      snapshots.push(snapshotWorktree(wt, opts.includeUntracked ?? false));
    } catch (e) {
      skipped.push({ worktree: wt.path, reason: e instanceof CeasefireGitError ? e.stderr : String(e) });
    }
  }
  const collisions: Collision[] = [];
  const jobs: Array<{ a: WorktreeSnapshot; b: WorktreeSnapshot }> = [];
  for (let i = 0; i < snapshots.length; i++) {
    for (let j = i + 1; j < snapshots.length; j++) {
      const a = snapshots[i] as WorktreeSnapshot;
      const b = snapshots[j] as WorktreeSnapshot;
      if (a.snapshot !== b.snapshot) jobs.push({ a, b });
    }
  }
  const results = mergeTreeConflictedFilesMany(
    cwd,
    jobs.map((p) => [p.a.snapshot, p.b.snapshot] as [string, string]),
  );
  jobs.forEach(({ a, b }, k) => {
    const r = results[k] as { files: string[] } | { error: Error };
    if ('error' in r) {
      skipped.push({ worktree: `${a.path} <-> ${b.path}`, reason: r.error.message });
      return;
    }
    if (r.files.length > 0) {
      const state = (s: WorktreeSnapshot): string => (s.dirty ? 'uncommitted changes' : 'committed only');
      collisions.push({
        prA: `${a.label} [worktree]`,
        prB: `${b.label} [worktree]`,
        files: r.files,
        severity: 'textual',
        detail: `${a.label}: ${state(a)}; ${b.label}: ${state(b)}`,
      });
    }
  });
  return { worktrees: snapshots, collisions, skipped };
}
