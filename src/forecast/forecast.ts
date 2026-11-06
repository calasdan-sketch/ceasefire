/**
 * Collision forecast.
 *
 * Textual collisions come from `git merge-tree --write-tree <a> <b>`
 * (git >= 2.38): a *real* merge, so rename detection, binary files,
 * modify/delete, and submodule conflicts are all caught — the old
 * 3-argument "trivial merge" mode missed renames and binaries and could
 * only signal them through fragile `<<<<<<<` marker parsing. The new
 * output lists unmerged paths as `<mode> <oid> <stage>\t<path>` records
 * (NUL-separated with `-z`), which cannot false-positive on file content.
 *
 * On git < 2.38 we fall back to the legacy 3-argument merge-tree output,
 * with one hardening: a file is only flagged when its block contains the
 * full conflict-marker trio (`<<<<<<<` / `=======` / `>>>>>>>` with
 * merge-tree's `.our`/`.their` labels), so a clean merge that merely
 * *displays* a literal `<<<<<<< ` content line is not misreported.
 *
 * Known git blind spot (documented, not fixed here): same-file disjoint
 * edits merge cleanly, so merge-tree reports no conflict even though two
 * agents touched the same file. The intent ledger covers that case
 * advisorially — that is exactly what `ceasefire check` is for.
 *
 * Intent collisions are advisory: two *active* intents from *different*
 * agents whose claimed paths overlap (exact match or directory prefix).
 */
import { git, gitResult, mergeBase, CeasefireGitError } from './git.js';
export { mergeBase } from './git.js';
import type { Collision, Intent } from '../types.js';

/** Minimum git for `merge-tree --write-tree` (new output format). */
const WRITE_TREE_MIN = { major: 2, minor: 38 };

let writeTreeSupport: boolean | null = null;

/** True when the local git understands `merge-tree --write-tree`. Cached. */
export function gitSupportsWriteTree(cwd: string): boolean {
  if (writeTreeSupport !== null) return writeTreeSupport;
  try {
    const m = /git version (\d+)\.(\d+)/.exec(git(cwd, ['--version']));
    const major = m?.[1] !== undefined ? parseInt(m[1], 10) : 0;
    const minor = m?.[2] !== undefined ? parseInt(m[2], 10) : 0;
    writeTreeSupport =
      major > WRITE_TREE_MIN.major ||
      (major === WRITE_TREE_MIN.major && minor >= WRITE_TREE_MIN.minor);
  } catch {
    writeTreeSupport = false;
  }
  return writeTreeSupport;
}

/** Reset the cached capability probe. Exported for tests. */
export function resetGitCapabilityCache(): void {
  writeTreeSupport = null;
}

/**
 * Unmerged-path record in `merge-tree -z --write-tree` output:
 * `<mode> <oid> <stage>\t<path>` — stage 1/2/3 means the path is
 * conflicted (base/ours/theirs). The path is raw (NUL-separated), so
 * newlines, tabs, and quotes in filenames parse correctly.
 */
const STAGED_PATH_RE = /^[0-7]{6} [0-9a-f]+ ([123])\t([\s\S]*)$/;

/** Fallback: `CONFLICT (content): Merge conflict in <path>` message lines. */
const CONFLICT_MSG_RE = /^CONFLICT \([^)]*\): Merge conflict in (.+)$/;

/**
 * Files with conflicting hunks if branches `ours` and `theirs` were merged.
 * Uses a real merge (`--write-tree`), so renames, binaries, delete/modify
 * pairs, and submodule bumps are all detected. Returns repo-relative paths,
 * sorted. Throws CeasefireGitError when the merge itself cannot run (e.g.
 * unrelated histories) — callers isolate failures per pair.
 */
export function mergeTreeConflictedFiles(cwd: string, ours: string, theirs: string): string[] {
  if (!gitSupportsWriteTree(cwd)) {
    return mergeTreeConflictedFilesLegacy(cwd, mergeBase(cwd, ours, theirs), ours, theirs);
  }
  const result = gitResult(cwd, ['merge-tree', '-z', '--write-tree', ours, theirs]);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    // Exit 1 = conflicts found (output still parsed below). Anything else
    // (128, …) means the merge could not run at all.
    throw new CeasefireGitError(
      `merge-tree --write-tree ${ours} ${theirs}`,
      result.stderr.trim() || `git merge-tree exited with code ${result.exitCode}`,
    );
  }
  const conflicted = new Set<string>();
  for (const record of result.stdout.split('\0')) {
    const staged = STAGED_PATH_RE.exec(record);
    if (staged?.[2] !== undefined) {
      conflicted.add(staged[2]);
      continue;
    }
    // Belt-and-braces: if git ever reports a conflict without a staged
    // entry, catch the stable "Merge conflict in <path>" message shape.
    // (Messages are NUL-separated records that may contain newlines.)
    for (const line of record.split('\n')) {
      const msg = CONFLICT_MSG_RE.exec(line.trim());
      if (msg?.[1] !== undefined) conflicted.add(msg[1]);
    }
  }
  return [...conflicted].sort();
}

/** Blob line in legacy merge-tree output: `  base|our|their|result <mode> <oid> <path>` */
const BLOB_LINE = /^\s+(?:base|our|their|result)\s+[0-9]{6}\s+[0-9a-f]{40}\s+(.*)$/;
/** Legacy conflict markers carry merge-tree's fixed `.our`/`.their` labels. */
const LEGACY_OPEN = /^[+ ]<{7} \.(our|their)([ \t]|$)/;
const LEGACY_MID = /^[+ ]={7}([ \t]|$)/;
const LEGACY_CLOSE = /^[+ ]>{7} \.(our|their)([ \t]|$)/;

/**
 * Legacy parser for git < 2.38 (3-argument trivial merge-tree). A file is
 * only reported when its block contains the *full* marker trio, so literal
 * `<<<<<<< ` lines in cleanly-merged content cannot false-positive.
 */
export function mergeTreeConflictedFilesLegacy(
  cwd: string,
  base: string,
  ours: string,
  theirs: string,
): string[] {
  const out = git(cwd, ['merge-tree', base, ours, theirs]);
  const conflicted = new Set<string>();
  let current: string | null = null;
  let seenOpen = false;
  let seenMid = false;
  const flush = (): void => {
    seenOpen = false;
    seenMid = false;
  };
  for (const line of out.split('\n')) {
    const blob = BLOB_LINE.exec(line);
    if (blob?.[1]) {
      // A new blob line ends the previous file's hunk region: an
      // unterminated marker trio was literal content, not a conflict.
      flush();
      current = blob[1];
      continue;
    }
    if (current === null) continue;
    if (LEGACY_OPEN.test(line)) {
      seenOpen = true;
      continue;
    }
    if (seenOpen && LEGACY_MID.test(line)) {
      seenMid = true;
      continue;
    }
    if (seenOpen && seenMid && LEGACY_CLOSE.test(line)) {
      conflicted.add(current);
      flush();
    }
  }
  return [...conflicted].sort();
}

/**
 * Pairwise textual collisions across branches. Each unordered pair is
 * checked once; a branch is never compared against itself.
 *
 * A pair that cannot be forecast (unrelated histories, unreadable ref, …)
 * is skipped via `onSkip` instead of failing the whole matrix — one bad
 * pair must not blind the forecast for every other pair.
 */
export function textualCollisions(
  cwd: string,
  branches: string[],
  onSkip?: (a: string, b: string, reason: string) => void,
): Collision[] {
  const collisions: Collision[] = [];
  const unique = [...new Set(branches)];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i] as string;
      const b = unique[j] as string;
      let files: string[];
      try {
        files = mergeTreeConflictedFiles(cwd, a, b);
      } catch (e) {
        onSkip?.(a, b, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (files.length > 0) {
        collisions.push({ prA: a, prB: b, files, severity: 'textual' });
      }
    }
  }
  return collisions;
}

export { normalizePath, pathsOverlap, canonicalizePath, globMatch, isGlob, PathOutsideRepoError } from './paths.js';
import { normalizePath, pathsOverlap } from './paths.js';

/**
 * Advisory intent collisions: pairs of *active, unexpired* intents from
 * *different* agents with overlapping paths.
 */
export function intentCollisions(intents: Intent[], now: number = Date.now()): Collision[] {
  const live = intents.filter((i) => i.status === 'active' && i.expiresAt > now);
  const collisions: Collision[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as Intent;
      const b = live[j] as Intent;
      if (a.agent === b.agent) continue;
      const files = [
        ...new Set(
          a.paths.flatMap((pa) => b.paths.filter((pb) => pathsOverlap(pa, pb)).map((pb) => normalizePath(pb))),
        ),
      ].sort();
      if (files.length > 0) {
        collisions.push({
          prA: `${a.agent}/${a.branch} (${a.id.slice(0, 8)})`,
          prB: `${b.agent}/${b.branch} (${b.id.slice(0, 8)})`,
          files,
          severity: 'intent',
          detail: `"${a.task}" vs "${b.task}"`,
        });
      }
    }
  }
  return collisions;
}

/** Full collision matrix: textual branch collisions + intent collisions. */
export function buildCollisionMatrix(
  cwd: string,
  branches: string[],
  intents: Intent[],
  now: number = Date.now(),
  onSkipPair?: (a: string, b: string, reason: string) => void,
): Collision[] {
  return [...textualCollisions(cwd, branches, onSkipPair), ...intentCollisions(intents, now)];
}
