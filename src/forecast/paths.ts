/**
 * Path canonicalization and glob matching for intent claims.
 *
 * Agents name files in many shapes: `src/a.ts`, `./src/a.ts`,
 * `/home/me/repo/src/a.ts` (Claude Code hooks pass absolute paths),
 * `src\\a.ts` or `C:\\repo\\src\\a.ts` on Windows, or `../a.ts` from a
 * subdirectory. Two agents naming the same file differently must still
 * collide, so every claim and every checked file is reduced to one
 * canonical repo-relative POSIX form before comparison.
 *
 * Claims may also be globs (`src/**\/*.test.ts`, `docs/*.md`). Matching is
 * implemented here with a linear-time segment matcher (no RegExp built from
 * user input, so a hostile pattern cannot trigger catastrophic backtracking)
 * and no dependency.
 */
import { isAbsolute, relative, resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';

/** Longest pattern / path we accept for matching. Longer input never matches. */
export const MAX_PATTERN_LENGTH = 4096;

/** True when the string contains glob metacharacters (`*`, `?`, `[`). */
export function isGlob(p: string): boolean {
  return /[*?[]/.test(p);
}

/** Windows drive (`C:\`, `c:/`) or UNC (`\\server\share`) absolute path. */
function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Lexical normalization to a POSIX-style relative path: backslashes become
 * `/`, empty and `.` segments are dropped, `..` pops a segment. A leading
 * `..` that cannot be popped is kept (the path escapes its base).
 * Absolute inputs keep a leading `/` (or `X:/` drive) so callers can tell.
 */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  let prefix = '';
  const drive = /^([A-Za-z]:)\//.exec(s);
  if (drive) {
    prefix = `${drive[1]}/`;
    s = s.slice(3);
  } else if (s.startsWith('/')) {
    prefix = '/';
  }
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function realpathLoose(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) break;
      tail.push(basename(cur));
      cur = parent;
    }
  }
  return abs;
}

export class PathOutsideRepoError extends Error {
  readonly input: string;
  constructor(input: string) {
    super(`path is outside the repository: ${input}`);
    this.name = 'PathOutsideRepoError';
    this.input = input;
  }
}

/**
 * Canonical repo-relative POSIX path for a claim or checked file.
 *
 * - Relative paths resolve against `cwd` (so `ceasefire check a.ts` run in
 *   `src/` means `src/a.ts`), then become relative to `repoRoot`.
 * - Absolute POSIX paths are made relative to `repoRoot` (symlinks resolved,
 *   so macOS `/tmp` vs `/private/tmp` agree).
 * - Windows absolute paths are compared case-insensitively against the root.
 * - Globs are resolved lexically (their literal prefix is anchored the same way).
 *
 * Throws PathOutsideRepoError when the path escapes the repository.
 * Without a repo root, falls back to lexical normalization only.
 */
export function canonicalizePath(input: string, cwd: string, repoRoot: string | null): string {
  const raw = input.trim();
  if (!repoRoot) {
    const n = normalizePath(raw);
    return n.replace(/^\/+/, '');
  }
  const winAbs = isWindowsAbsolute(raw);
  if (winAbs || /^[A-Za-z]:[\\/]/.test(repoRoot)) {
    // Windows-style comparison: purely lexical and case-insensitive.
    const root = normalizePath(repoRoot);
    const target = winAbs ? normalizePath(raw) : normalizePath(`${root}/${relWinCwd(cwd, root)}/${raw}`);
    const lr = root.toLowerCase();
    const lt = target.toLowerCase();
    if (lt === lr) return '';
    if (!lt.startsWith(lr.endsWith('/') ? lr : lr + '/')) throw new PathOutsideRepoError(input);
    return target.slice(lr.endsWith('/') ? lr.length : lr.length + 1);
  }
  const rootReal = realpathLoose(repoRoot);
  let abs: string;
  if (isAbsolute(raw)) {
    abs = raw;
  } else {
    abs = resolve(realpathLoose(cwd), raw.replace(/\\/g, '/'));
  }
  // Do not realpath glob patterns (their wildcard segments are not files).
  const real = isGlob(abs) ? resolveGlobAnchor(abs) : realpathLoose(abs);
  const rel = relative(rootReal, real).split(sep).join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new PathOutsideRepoError(input);
  return normalizePath(rel);
}

function relWinCwd(cwd: string, root: string): string {
  const c = normalizePath(cwd);
  const lc = c.toLowerCase();
  const lr = root.toLowerCase();
  return lc.startsWith(lr) ? c.slice(root.length) : '';
}

/** realpath only the literal (non-glob) leading segments of a pattern. */
function resolveGlobAnchor(abs: string): string {
  const segs = abs.split('/');
  const firstGlob = segs.findIndex((s) => isGlob(s));
  const anchor = segs.slice(0, firstGlob).join('/') || '/';
  const rest = segs.slice(firstGlob);
  return join(realpathLoose(anchor), ...rest);
}

/* ------------------------------------------------------------------ */
/* glob matching                                                       */
/* ------------------------------------------------------------------ */

/** Match one path segment against one pattern segment (`*`, `?`, `[...]`). */
function matchSegment(pat: string, str: string): boolean {
  // Iterative wildcard matcher with single backtrack point: O(len(pat)*len(str)) worst case.
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < str.length) {
    if (p < pat.length) {
      const c = pat[p] as string;
      if (c === '*') {
        starP = p++;
        starS = s;
        continue;
      }
      if (c === '?') {
        p++;
        s++;
        continue;
      }
      if (c === '[') {
        const cls = parseClass(pat, p);
        if (cls && cls.test(str[s] as string)) {
          p = cls.end;
          s++;
          continue;
        }
        if (!cls && str[s] === '[') {
          p++;
          s++;
          continue;
        }
      } else if (c === str[s]) {
        p++;
        s++;
        continue;
      }
    }
    if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
      continue;
    }
    return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/** Parse `[abc]`, `[a-z]`, `[!x]` / `[^x]` at `start`; null when unterminated. */
function parseClass(pat: string, start: number): { end: number; test: (ch: string) => boolean } | null {
  let i = start + 1;
  let negate = false;
  if (pat[i] === '!' || pat[i] === '^') {
    negate = true;
    i++;
  }
  const ranges: Array<[string, string]> = [];
  let first = true;
  while (i < pat.length && (pat[i] !== ']' || first)) {
    first = false;
    const lo = pat[i] as string;
    if (pat[i + 1] === '-' && i + 2 < pat.length && pat[i + 2] !== ']') {
      ranges.push([lo, pat[i + 2] as string]);
      i += 3;
    } else {
      ranges.push([lo, lo]);
      i++;
    }
  }
  if (i >= pat.length) return null;
  return {
    end: i + 1,
    test: (ch) => ranges.some(([a, b]) => ch >= a && ch <= b) !== negate,
  };
}

/**
 * True when repo-relative `path` matches glob `pattern`.
 * `**` as a whole segment matches zero or more segments; `*` and `?` never
 * cross `/`. Linear-ish DP over segments; inputs over MAX_PATTERN_LENGTH never match.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH || path.length > MAX_PATTERN_LENGTH) return false;
  const ps = normalizePath(pattern).split('/').filter(Boolean);
  const ss = normalizePath(path).split('/').filter(Boolean);
  // dp[j] = pattern prefix (current i) matches path prefix of length j
  let dp: boolean[] = new Array<boolean>(ss.length + 1).fill(false);
  dp[0] = true;
  for (const seg of ps) {
    const next: boolean[] = new Array<boolean>(ss.length + 1).fill(false);
    if (seg === '**') {
      let any = false;
      for (let j = 0; j <= ss.length; j++) {
        any = any || (dp[j] as boolean);
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= ss.length; j++) {
        next[j] = (dp[j - 1] as boolean) && matchSegment(seg, ss[j - 1] as string);
      }
    }
    dp = next;
  }
  return dp[ss.length] as boolean;
}

/** Literal leading directory of a glob (`src/auth/**\/*.ts` -> `src/auth`). */
export function globLiteralPrefix(pattern: string): string {
  const segs = normalizePath(pattern).split('/').filter(Boolean);
  const out: string[] = [];
  for (const s of segs) {
    if (isGlob(s)) break;
    out.push(s);
  }
  return out.join('/');
}

function prefixRelated(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * True when two claimed paths overlap.
 *
 * - literal vs literal: equal, or one is a directory containing the other.
 * - literal vs glob: the literal matches the glob, or the literal is a
 *   directory that could contain matches (it is related to the glob's
 *   literal prefix). Conservative: reports *possible* overlap.
 * - glob vs glob: their literal prefixes are related (conservative).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  const ga = isGlob(na);
  const gb = isGlob(nb);
  if (!ga && !gb) return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
  if (ga && gb) return prefixRelated(globLiteralPrefix(na), globLiteralPrefix(nb));
  const [glob, lit] = ga ? [na, nb] : [nb, na];
  if (globMatch(glob, lit)) return true;
  // A directory claim could contain files the glob matches (or vice versa).
  const prefix = globLiteralPrefix(glob);
  return prefix === '' ? false : prefix.startsWith(lit + '/') || prefix === lit;
}
