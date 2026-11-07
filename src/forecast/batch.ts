/**
 * Batched `git merge-tree --stdin`: many merges in ONE git process.
 *
 * The pairwise forecast is O(N^2) merges, and spawning git once per pair
 * dominated the run time (process start-up, not merging). `--stdin`
 * (git >= 2.40) reads one `<a> <b>` pair per line and prints, per pair:
 *
 *   <status> NUL <tree-oid> NUL <conflicted path> NUL ... NUL NUL
 *
 * (status 1 = clean, 0 = conflicts; `--no-messages --name-only -z`). A fatal
 * error (e.g. unrelated histories) aborts the whole process after the pairs
 * already printed, so the parser keeps the complete records it got and the
 * caller re-runs the rest one pair at a time. Nothing here can mis-report a
 * conflict: an unparseable or truncated record is dropped, never "clean".
 */
import { gitResult } from './git.js';

/** Pairs per git process: bounds stdout memory and the blast radius of one fatal pair. */
export const BATCH_CHUNK = 256;

const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OBJECT_NAME_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Parse `merge-tree --stdin -z --name-only --no-messages` output; stops at the first incomplete or odd record. */
export function parseMergeTreeStdin(stdout: string, expected: number): string[][] {
  const tokens = stdout.split('\0');
  const out: string[][] = [];
  let i = 0;
  while (out.length < expected) {
    const status = tokens[i];
    const oid = tokens[i + 1];
    if ((status !== '0' && status !== '1') || oid === undefined || !OID_RE.test(oid)) break;
    const files: string[] = [];
    let j = i + 2;
    while (j < tokens.length && tokens[j] !== '') {
      files.push(tokens[j] as string);
      j++;
    }
    // A complete record ends with an empty token (the NUL NUL terminator); running off the end means truncation.
    if (j >= tokens.length) break;
    if (status === '1' && files.length > 0) break; // clean merges list no paths: anything else is not the format we know
    out.push([...new Set(files)].sort());
    i = j + 1;
  }
  return out;
}

/**
 * Conflicted files for each `[a, b]` commit-id pair, via `merge-tree --stdin`.
 * Returns an array parallel to `pairs`; entries past the first failure are
 * `null` (the caller falls back to one merge per pair for those). Inputs
 * must be full object ids: they travel on stdin, never in argv.
 */
export function mergeTreeBatch(cwd: string, pairs: Array<[string, string]>): Array<string[] | null> {
  const result: Array<string[] | null> = new Array<string[] | null>(pairs.length).fill(null);
  for (let start = 0; start < pairs.length; start += BATCH_CHUNK) {
    const chunk = pairs.slice(start, start + BATCH_CHUNK);
    if (chunk.some(([a, b]) => !OBJECT_NAME_RE.test(a) || !OBJECT_NAME_RE.test(b))) continue;
    const r = gitResult(cwd, ['merge-tree', '--stdin', '--write-tree', '-z', '--name-only', '--no-messages'], {
      input: chunk.map(([a, b]) => `${a} ${b}`).join('\n') + '\n',
    });
    const parsed = parseMergeTreeStdin(r.stdout, chunk.length);
    parsed.forEach((files, k) => {
      result[start + k] = files;
    });
    // On a fatal pair every later pair in this chunk stays null; later chunks still get their own process.
  }
  return result;
}

/** `--stdin` landed in git 2.40. */
export function gitSupportsMergeTreeStdin(versionText: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(versionText);
  if (!m) return false;
  const major = parseInt(m[1] as string, 10);
  const minor = parseInt(m[2] as string, 10);
  return major > 2 || (major === 2 && minor >= 40);
}
