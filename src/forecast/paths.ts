/**
 * Path canonicalization and glob matching for intent claims.
 *
 * Agents name files in many shapes: `src/a.ts`, `./src/a.ts`,
 * `/home/me/repo/src/a.ts` (Claude Code hooks pass absolute paths),
 * `src\\a.ts`, `C:\\repo\\src\\a.ts`, `\\\\?\\C:\\repo\\...` or MSYS
 * `/c/repo/...` on Windows, or `../a.ts` from a subdirectory. Two agents
 * naming the same file differently must still collide, so every claim and
 * every checked file is reduced to one repo-relative POSIX form.
 *
 * Case: on case-insensitive filesystems (Windows, default macOS) callers
 * pass `ignoreCase`, and every comparison folds case.
 *
 * Claims may be globs (`src/**\/*.test.ts`, `docs/*.md`, `[a-z]` classes).
 * A metacharacter preceded by a backslash (`\\[`, `\\*`, `\\?`, `\\]`) is a
 * literal; that is the one place a backslash is not a path separator.
 * Files being *checked* are always literal, so `app/[id]/page.tsx` is a file
 * name, never a pattern. Matching pre-compiles each pattern segment and runs
 * in O(pattern x path) time; no RegExp is built from user input.
 */
import { isAbsolute, relative, resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';

/** Longest pattern / path we accept for matching. Longer input never matches. */
export const MAX_PATTERN_LENGTH = 4096;

export interface MatchOptions {
  /** Fold case in every comparison (case-insensitive filesystem). */
  ignoreCase?: boolean;
}

/** True when the string contains an *unescaped* glob metacharacter (`*`, `?`, `[`). */
export function isGlob(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length && isMeta(p[i + 1] as string)) {
      i++;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') return true;
  }
  return false;
}

function isMeta(c: string): boolean {
  return c === '*' || c === '?' || c === '[' || c === ']' || c === '\\';
}

/** Remove glob escapes: `app/\[id\]` -> `app/[id]`. */
export function unescapeGlob(p: string): string {
  return p.replace(/\\([*?[\]\\])/g, '$1');
}

/** Escape glob metacharacters so a literal file name can be stored as a claim. */
export function escapeGlob(p: string): string {
  return p.replace(/([*?[\]])/g, '\\$1');
}

/** Backslashes that are path separators (i.e. not escaping a glob metachar) become `/`. */
function slashify(p: string): string {
  return p.replace(/\\(?![*?[\]])/g, '/');
}

/** `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\share` -> `\\srv\share`. */
function stripLongPathPrefix(p: string): string {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p)) return '\\\\' + p.slice(8);
  if (/^[\\/]{2}\?[\\/]/.test(p)) return p.slice(4);
  return p;
}

/**
 * Lexical normalization to a POSIX-style path: separator backslashes become
 * `/`, empty and `.` segments are dropped, `..` pops a segment. A leading
 * `..` that cannot be popped is kept (the path escapes its base).
 * Absolute inputs keep a leading `/`, `//` (UNC) or `X:/` prefix.
 */
export function normalizePath(p: string): string {
  let s = slashify(stripLongPathPrefix(p.trim()));
  let prefix = '';
  const drive = /^([A-Za-z]:)\//.exec(s);
  if (drive) {
    prefix = `${(drive[1] as string).toUpperCase()}/`;
    s = s.slice(3);
  } else if (s.startsWith('//') && !s.startsWith('///')) {
    prefix = '//';
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
  constructor(input: string, why = 'path is outside the repository') {
    super(`${why}: ${input}`);
    this.name = 'PathOutsideRepoError';
    this.input = input;
  }
}

/** True when `p` is a Windows-style root (`C:/...`, `//server/share`). */
function isWindowsRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/?]/.test(p);
}

/** `child` relative to `root` when inside it ('' for the root itself), else null. */
function relInside(child: string, root: string, ignoreCase: boolean): string | null {
  const c = ignoreCase ? child.toLowerCase() : child;
  const r = (ignoreCase ? root.toLowerCase() : root).replace(/\/+$/, '');
  if (c === r) return '';
  if (r === '' || r.endsWith(':')) return null;
  if (c.startsWith(r + '/')) return child.slice(r.length + 1);
  return null;
}

/**
 * Canonical repo-relative POSIX path for a claim or checked file.
 *
 * - Relative paths resolve against `cwd`, then become relative to `repoRoot`.
 * - Absolute POSIX paths are made relative to `repoRoot` (symlinks resolved).
 * - On a Windows root: drive, `\\?\` and UNC paths are compared lexically and
 *   case-insensitively; MSYS `/c/...` maps to `C:/...`; other POSIX absolute
 *   paths and drive-relative `C:x` paths are refused.
 * - Globs are resolved lexically (only their literal prefix is realpath'd).
 *
 * Throws PathOutsideRepoError when the path escapes the repository.
 * Without a repo root, falls back to lexical normalization only.
 */
export function canonicalizePath(
  input: string,
  cwd: string,
  repoRoot: string | null,
  opts: MatchOptions = {},
): string {
  const raw = stripLongPathPrefix(input.trim());
  if (/^[A-Za-z]:(?![\\/])/.test(raw)) throw new PathOutsideRepoError(input, 'drive-relative path is ambiguous');
  if (!repoRoot) {
    const n = normalizePath(raw);
    return n.replace(/^(?:[A-Z]:)?\/+/, '');
  }
  const winRoot = isWindowsRoot(repoRoot);
  if (winRoot || isWindowsRoot(raw)) {
    if (!winRoot) throw new PathOutsideRepoError(input);
    // Windows-style comparison: purely lexical, always case-insensitive.
    const root = normalizePath(stripLongPathPrefix(repoRoot));
    let target: string;
    const msys = /^\/([A-Za-z])(\/|$)/.exec(raw);
    if (isWindowsRoot(raw)) target = normalizePath(raw);
    else if (msys) target = normalizePath(`${(msys[1] as string).toUpperCase()}:/${raw.slice(3)}`);
    else if (raw.startsWith('/') || raw.startsWith('\\')) throw new PathOutsideRepoError(input);
    else {
      const c = normalizePath(stripLongPathPrefix(cwd));
      const base = isWindowsRoot(c) && relInside(c, root, true) !== null ? c : root;
      target = normalizePath(`${base}/${raw}`);
    }
    const rel = relInside(target, root, true);
    if (rel === null) throw new PathOutsideRepoError(input);
    return rel;
  }
  const ignoreCase = opts.ignoreCase ?? false;
  const rootReal = realpathLoose(repoRoot);
  const abs = isAbsolute(raw) ? raw : resolve(realpathLoose(cwd), slashify(raw));
  // Do not realpath glob patterns (their wildcard segments are not files).
  const real = isGlob(abs) ? resolveGlobAnchor(abs) : realpathLoose(abs);
  const rel = relative(rootReal, real).split(sep).join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    // realpathSync keeps the caller's casing on case-insensitive volumes:
    // `/TMP/repo/a` and `/tmp/repo/a` are one file there.
    const inside = ignoreCase ? relInside(normalizePath(real), normalizePath(rootReal), true) : null;
    if (inside === null) throw new PathOutsideRepoError(input);
    return normalizePath(inside);
  }
  return normalizePath(rel);
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

type Token =
  | { t: 'lit'; c: string }
  | { t: 'one' }
  | { t: 'star' }
  | { t: 'cls'; neg: boolean; ranges: Array<[string, string]> };

/** Compile one pattern segment into tokens. Unterminated `[` is a literal. O(n). */
function compileSegment(pat: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i] as string;
    if (c === '\\' && i + 1 < pat.length && isMeta(pat[i + 1] as string)) {
      out.push({ t: 'lit', c: pat[++i] as string });
    } else if (c === '*') {
      if (out[out.length - 1]?.t !== 'star') out.push({ t: 'star' });
    } else if (c === '?') {
      out.push({ t: 'one' });
    } else if (c === '[') {
      const end = findClassEnd(pat, i);
      if (end < 0) {
        out.push({ t: 'lit', c: '[' });
        continue;
      }
      let j = i + 1;
      let neg = false;
      if (pat[j] === '!' || pat[j] === '^') {
        neg = true;
        j++;
      }
      const ranges: Array<[string, string]> = [];
      while (j < end) {
        let lo = pat[j] as string;
        if (lo === '\\' && j + 1 < end) lo = pat[++j] as string;
        if (pat[j + 1] === '-' && j + 2 < end) {
          let hi = pat[j + 2] as string;
          let step = 3;
          if (hi === '\\' && j + 3 < end) {
            hi = pat[j + 3] as string;
            step = 4;
          }
          ranges.push([lo, hi]);
          j += step;
        } else {
          ranges.push([lo, lo]);
          j++;
        }
      }
      out.push({ t: 'cls', neg, ranges });
      i = end;
    } else {
      out.push({ t: 'lit', c });
    }
  }
  return out;
}

/** Index of the `]` closing a class opened at `start`, or -1. Single forward scan. */
function findClassEnd(pat: string, start: number): number {
  let j = start + 1;
  if (pat[j] === '!' || pat[j] === '^') j++;
  if (pat[j] === ']') j++; // `[]]` / `[!]]`: leading ] is a member
  for (; j < pat.length; j++) {
    if (pat[j] === '\\') {
      j++;
      continue;
    }
    if (pat[j] === ']') return j;
  }
  return -1;
}

function tokenMatches(tok: Token, ch: string): boolean {
  if (tok.t === 'lit') return tok.c === ch;
  if (tok.t === 'one') return true;
  if (tok.t === 'cls') return tok.ranges.some(([a, b]) => ch >= a && ch <= b) !== tok.neg;
  return false;
}

/** Match a compiled segment: classic greedy star with one backtrack point, O(len(tokens) x len(str)). */
function matchTokens(toks: Token[], str: string): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < str.length) {
    const tok = toks[p];
    if (tok !== undefined && tok.t === 'star') {
      starP = p++;
      starS = s;
      continue;
    }
    if (tok !== undefined && tokenMatches(tok, str[s] as string)) {
      p++;
      s++;
      continue;
    }
    if (starP >= 0) {
      p = starP + 1;
      s = ++starS;
      continue;
    }
    return false;
  }
  while (p < toks.length && toks[p]?.t === 'star') p++;
  return p === toks.length;
}

/** Split a pattern into segments, keeping escaped metachars intact. */
function patternSegments(pattern: string): string[] {
  return normalizePath(pattern).replace(/^(?:[A-Z]:)?\/+/, '').split('/').filter(Boolean);
}

function fold(s: string, o: MatchOptions): string {
  return o.ignoreCase ? s.toLowerCase() : s;
}

/**
 * True when literal repo-relative `path` matches glob `pattern`.
 * `**` as a whole segment matches zero or more segments; `*` and `?` never
 * cross `/`. O(pattern x path); inputs over MAX_PATTERN_LENGTH never match.
 */
export function globMatch(pattern: string, path: string, o: MatchOptions = {}): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH || path.length > MAX_PATTERN_LENGTH) return false;
  const ps = patternSegments(fold(pattern, o)).map((seg) => (seg === '**' ? null : compileSegment(seg)));
  const ss = literalSegments(fold(path, o));
  let dp: boolean[] = new Array<boolean>(ss.length + 1).fill(false);
  dp[0] = true;
  for (const seg of ps) {
    const next: boolean[] = new Array<boolean>(ss.length + 1).fill(false);
    if (seg === null) {
      let any = false;
      for (let j = 0; j <= ss.length; j++) {
        any = any || (dp[j] as boolean);
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= ss.length; j++) {
        next[j] = (dp[j - 1] as boolean) && matchTokens(seg, ss[j - 1] as string);
      }
    }
    dp = next;
  }
  return dp[ss.length] as boolean;
}

/** Segments of a literal path (no glob interpretation, backslashes are separators). */
function literalSegments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

/** Literal leading directory of a glob (`src/auth/**\/*.ts` -> `src/auth`), unescaped. */
export function globLiteralPrefix(pattern: string): string {
  const out: string[] = [];
  for (const s of patternSegments(pattern)) {
    if (isGlob(s)) break;
    out.push(unescapeGlob(s));
  }
  return out.join('/');
}

/** Literal-path overlap: equal, or one is a directory containing the other. */
function literalOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** Normalized literal form of a claim: unescaped when it has no wildcards. */
function claimLiteral(n: string): string {
  return unescapeGlob(n);
}

/**
 * Could two glob claims match a common path? Segment-wise NFA product with
 * memo, O(segments(a) x segments(b)). Two wildcard segments are assumed
 * compatible (conservative); a literal segment must match the other side.
 */
function globsMayIntersect(a: string, b: string, o: MatchOptions): boolean {
  const as = patternSegments(fold(a, o));
  const bs = patternSegments(fold(b, o));
  const memo = new Map<number, boolean>();
  const W = bs.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * W + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    memo.set(key, false);
    let r: boolean;
    if (i === as.length && j === bs.length) r = true;
    else if (as[i] === '**') r = go(i + 1, j) || (j < bs.length && go(i, j + 1));
    else if (bs[j] === '**') r = go(i, j + 1) || (i < as.length && go(i + 1, j));
    else if (i === as.length || j === bs.length) r = false;
    else r = segmentsCompatible(as[i] as string, bs[j] as string) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function segmentsCompatible(x: string, y: string): boolean {
  const gx = isGlob(x);
  const gy = isGlob(y);
  if (!gx && !gy) return unescapeGlob(x) === unescapeGlob(y);
  if (gx && gy) return true;
  return gx ? matchTokens(compileSegment(x), unescapeGlob(y)) : matchTokens(compileSegment(y), unescapeGlob(x));
}

/**
 * Does a literal path (a file or directory being checked) overlap a claim?
 *
 * - literal claim: equal, or one is a directory containing the other.
 * - glob claim: the file matches it; or the file is a directory that holds
 *   the glob's literal root; or the claim's text equals the file exactly
 *   (an unescaped `app/[id]/page.tsx` claim still covers that file).
 */
export function fileMatchesClaim(file: string, claim: string, o: MatchOptions = {}): boolean {
  const f = fold(normalizePath(file.replace(/\\/g, '/')), o);
  const c = fold(normalizePath(claim), o);
  if (!f || !c) return false;
  if (!isGlob(c)) return literalOverlap(f, claimLiteral(c));
  if (f === c || globMatch(c, f)) return true;
  const prefix = globLiteralPrefix(c);
  return prefix !== '' && (prefix === f || prefix.startsWith(f + '/'));
}

/**
 * True when two *claims* overlap (both may be globs).
 *
 * - literal vs literal: equal, or one is a directory containing the other.
 * - literal vs glob: as fileMatchesClaim.
 * - glob vs glob: they could match a common path (conservative per segment).
 */
export function pathsOverlap(a: string, b: string, o: MatchOptions = {}): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  const ga = isGlob(na);
  const gb = isGlob(nb);
  if (!ga && !gb) return literalOverlap(fold(claimLiteral(na), o), fold(claimLiteral(nb), o));
  if (ga && gb) return fold(na, o) === fold(nb, o) || globsMayIntersect(na, nb, o);
  return ga ? fileMatchesClaim(claimLiteral(nb), na, o) : fileMatchesClaim(claimLiteral(na), nb, o);
}
