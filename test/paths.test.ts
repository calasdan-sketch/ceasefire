/** Path canonicalization, glob claims, and overlap rules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, tempDir } from './helpers.js';
import {
  normalizePath,
  canonicalizePath,
  globMatch,
  pathsOverlap,
  PathOutsideRepoError,
  MAX_PATTERN_LENGTH,
} from '../src/forecast/paths.js';
import { sanitizeDisplay } from '../src/cli/format.js';
import { parseTtl } from '../src/cli/commands.js';

test('normalizePath collapses ./, //, . and .. segments and backslashes', () => {
  assert.equal(normalizePath('./src//auth/./login.ts'), 'src/auth/login.ts');
  assert.equal(normalizePath('src/auth/../db/x.ts'), 'src/db/x.ts');
  assert.equal(normalizePath('src\\auth\\login.ts'), 'src/auth/login.ts');
  assert.equal(normalizePath('src/auth/'), 'src/auth');
  assert.equal(normalizePath('../outside.ts'), '../outside.ts');
  assert.equal(normalizePath('/abs/../x'), '/x');
  assert.equal(normalizePath('C:\\repo\\src\\a.ts'), 'C:/repo/src/a.ts');
});

test('canonicalizePath: absolute, cwd-relative and ./ forms agree', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  const want = 'src/auth/login.ts';
  assert.equal(canonicalizePath('src/auth/login.ts', repo, repo), want);
  assert.equal(canonicalizePath('./src/auth/login.ts', repo, repo), want);
  assert.equal(canonicalizePath(join(repo, 'src/auth/login.ts'), repo, repo), want);
  assert.equal(canonicalizePath('login.ts', join(repo, 'src', 'auth'), repo), want, 'relative to cwd, not root');
  assert.equal(canonicalizePath('../auth/login.ts', join(repo, 'src', 'auth'), repo), want);
  assert.equal(canonicalizePath('src\\auth\\login.ts', repo, repo), want, 'windows separators');
});

test('canonicalizePath resolves symlinked roots (macOS /tmp vs /private/tmp style)', () => {
  const repo = makeRepo();
  const link = join(tempDir('ceasefire-link-'), 'repo-link');
  symlinkSync(repo, link);
  assert.equal(canonicalizePath(join(link, 'file.txt'), link, repo), 'file.txt');
});

test('canonicalizePath rejects paths that escape the repository', () => {
  const repo = makeRepo();
  assert.throws(() => canonicalizePath('../evil.ts', repo, repo), PathOutsideRepoError);
  assert.throws(() => canonicalizePath('/etc/passwd', repo, repo), PathOutsideRepoError);
  assert.throws(() => canonicalizePath('C:\\Windows\\x', repo, repo), PathOutsideRepoError);
});

test('canonicalizePath handles Windows repo roots case-insensitively', () => {
  assert.equal(canonicalizePath('c:\\Repo\\src\\a.ts', 'C:\\Repo', 'C:/Repo'), 'src/a.ts');
  assert.equal(canonicalizePath('src\\a.ts', 'C:\\Repo', 'C:/Repo'), 'src/a.ts');
  assert.equal(canonicalizePath('a.ts', 'C:\\Repo\\src', 'C:/Repo'), 'src/a.ts');
  assert.throws(() => canonicalizePath('D:\\other\\a.ts', 'C:\\Repo', 'C:/Repo'), PathOutsideRepoError);
});

test('canonicalizePath outside a repo falls back to lexical normalization', () => {
  assert.equal(canonicalizePath('./src//a.ts', '/nowhere', null), 'src/a.ts');
});

test('globMatch: *, ?, **, character classes', () => {
  assert.ok(globMatch('src/*.ts', 'src/a.ts'));
  assert.ok(!globMatch('src/*.ts', 'src/sub/a.ts'), '* does not cross /');
  assert.ok(globMatch('src/**/*.ts', 'src/a.ts'), '** matches zero segments');
  assert.ok(globMatch('src/**/*.ts', 'src/x/y/z.ts'));
  assert.ok(globMatch('**/*.test.ts', 'a/b/c.test.ts'));
  assert.ok(globMatch('src/?.ts', 'src/a.ts'));
  assert.ok(!globMatch('src/?.ts', 'src/ab.ts'));
  assert.ok(globMatch('src/[ab].ts', 'src/b.ts'));
  assert.ok(!globMatch('src/[!ab].ts', 'src/b.ts'));
  assert.ok(globMatch('src/[a-c]x.ts', 'src/bx.ts'));
  assert.ok(globMatch('docs/**', 'docs/a/b.md'));
  assert.ok(!globMatch('docs/*.md', 'other/a.md'));
});

test('globMatch is linear-time on hostile patterns and caps input length', () => {
  const evil = 'a/' + '*'.repeat(60) + 'b';
  const path = 'a/' + 'a'.repeat(4000);
  const t0 = Date.now();
  assert.equal(globMatch(evil, path), false);
  const deep = Array.from({ length: 200 }, () => '**').join('/') + '/x';
  assert.equal(globMatch(deep, 'a/'.repeat(1000) + 'y'), false);
  assert.ok(Date.now() - t0 < 1000, 'no catastrophic backtracking');
  assert.equal(globMatch('*'.repeat(MAX_PATTERN_LENGTH + 1), 'a'), false);
});

test('pathsOverlap: literal claims (unchanged v0.1 behaviour)', () => {
  assert.ok(pathsOverlap('src/a.ts', 'src/a.ts'));
  assert.ok(pathsOverlap('src/', 'src/a.ts'));
  assert.ok(pathsOverlap('./src/a.ts', 'src/a.ts'));
  assert.ok(!pathsOverlap('src/a.ts', 'src/ab.ts'));
  assert.ok(!pathsOverlap('', 'src/a.ts'));
});

test('pathsOverlap: glob claims against files and directories', () => {
  assert.ok(pathsOverlap('src/**/*.test.ts', 'src/auth/login.test.ts'));
  assert.ok(!pathsOverlap('src/**/*.test.ts', 'src/auth/login.ts'));
  assert.ok(pathsOverlap('src/auth/*.ts', 'src'), 'a directory claim containing the glob root overlaps');
  assert.ok(pathsOverlap('src/auth/*.ts', 'src/auth'));
  assert.ok(!pathsOverlap('src/auth/*.ts', 'docs'));
  assert.ok(pathsOverlap('src/**', 'src/a/**/*.md'), 'glob vs glob: related prefixes overlap (conservative)');
  assert.ok(!pathsOverlap('src/**', 'docs/*.md'));
});

test('sanitizeDisplay makes bidi, zero-width and C1 controls visible', () => {
  assert.equal(sanitizeDisplay('hermes\u200b'), 'hermes<U+200B>');
  assert.equal(sanitizeDisplay('a\u202eb'), 'a<U+202E>b');
  assert.equal(sanitizeDisplay('x\u009b31my'), 'x<U+009B>31my');
  assert.equal(sanitizeDisplay('\ufeffbom'), '<U+FEFF>bom');
  assert.equal(sanitizeDisplay('café ✓'), 'café ✓', 'ordinary unicode untouched');
});

test('parseTtl accepts s/m/h/d within 1 minute .. 7 days', () => {
  assert.equal(parseTtl('30m'), 30 * 60_000);
  assert.equal(parseTtl('2h'), 2 * 3_600_000);
  assert.equal(parseTtl('90s'), 90_000);
  assert.equal(parseTtl('7d'), 7 * 86_400_000);
  assert.equal(parseTtl('30s'), null, 'below 1 minute');
  assert.equal(parseTtl('8d'), null, 'above 7 days');
  assert.equal(parseTtl('-5m'), null);
  assert.equal(parseTtl('5'), null);
  assert.equal(parseTtl('1e9h'), null);
});
