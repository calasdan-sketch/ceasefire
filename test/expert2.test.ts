/** Expert round 2: batched forecast, deep (semantic/overlap) forecast, shared worktree ledger, auto-lease, status. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { git, makeRepo, makeBranch, tempDir } from './helpers.js';
import { parseMergeTreeStdin, mergeTreeBatch, gitSupportsMergeTreeStdin, BATCH_CHUNK } from '../src/forecast/batch.js';
import { textualCollisions, mergeTreeConflictedFilesMany, resetGitCapabilityCache } from '../src/forecast/forecast.js';
import { extractExports, extractImports, resolveImport, mentionsIdentifier, mentionsMember, langOf } from '../src/forecast/symbols.js';
import { deepForecast, parseRawDiff, addedLines } from '../src/forecast/deep.js';
import { regenHint, isRegenerable } from '../src/forecast/generated.js';
import { annotateRegenerable, claimLease, releaseLeases, cmdStatus, cmdConflicts, installClaudeHook } from '../src/cli/commands.js';
import { runClaudeHook, runReleaseHook } from '../src/cli/hook.js';
import { IntentStore, AUTO_LEASE_TASK } from '../src/intent/index.js';
import { resolveStoreDir } from '../src/intent/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');
const OID = 'a'.repeat(40);

function cli(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string }) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, CEASEFIRE_SYNC: '0', ...opts.env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: opts.input ?? '',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** Repo with an ES-module pair where main has lib.js exporting two functions. */
function jsRepo(): string {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'lib.js'), 'export function keep(x) {\n  return x;\n}\n\nexport function gone(x) {\n  return x + 1;\n}\n');
  writeFileSync(join(repo, 'src', 'app.js'), "import { keep } from './lib.js';\nexport const app = () => keep(1);\n");
  writeFileSync(join(repo, 'src', 'other.js'), 'export const other = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'js']);
  return repo;
}

/* ---------------------------- batched merge-tree ---------------------------- */

test('parseMergeTreeStdin: clean, conflicted, and truncated records', () => {
  const clean = `1\0${OID}\0\0`;
  const conflicted = `0\0${OID}\0src/a b.js\0weird\nname.js\0\0`;
  assert.deepEqual(parseMergeTreeStdin(clean + conflicted, 2), [[], ['src/a b.js', 'weird\nname.js']]);
  assert.deepEqual(parseMergeTreeStdin(clean + `0\0${OID}\0src/x.js`, 2), [[]], 'unterminated record is dropped, never read as clean');
  assert.deepEqual(parseMergeTreeStdin('fatal: nope', 3), []);
  assert.deepEqual(parseMergeTreeStdin(`1\0${OID}\0surprise\0\0`, 1), [], 'a clean record that lists paths is not our format');
  assert.deepEqual(parseMergeTreeStdin(`7\0${OID}\0\0`, 1), []);
});

test('git version gate for merge-tree --stdin', () => {
  assert.equal(gitSupportsMergeTreeStdin('git version 2.43.0'), true);
  assert.equal(gitSupportsMergeTreeStdin('git version 2.40.1'), true);
  assert.equal(gitSupportsMergeTreeStdin('git version 2.39.5'), false);
  assert.equal(gitSupportsMergeTreeStdin('git version 3.0.0'), true);
  assert.equal(gitSupportsMergeTreeStdin('garbage'), false);
});

test('batched and per-pair forecasts are identical, including unrelated and unreadable branches', () => {
  resetGitCapabilityCache();
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'line1\nA\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nB\nline3\nline4\nline5\n' });
  makeBranch(repo, 'c', { 'other.txt': 'changed\n' });
  makeBranch(repo, 'd', { 'file.txt': 'line1\nline2\nline3\nline4\nD\n', 'other.txt': 'also\n' });
  git(repo, ['checkout', '-q', '--orphan', 'island']);
  git(repo, ['rm', '-rfq', '.']);
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  git(repo, ['add', 'x.txt']);
  git(repo, ['commit', '-qm', 'island']);
  git(repo, ['checkout', '-q', 'main']);
  const names = ['a', 'b', 'c', 'd', 'island', 'no-such-branch'];
  const skipsBatch: string[] = [];
  const skipsSerial: string[] = [];
  const batched = textualCollisions(repo, names, (x, y) => skipsBatch.push(`${x}|${y}`));
  const serial = textualCollisions(repo, names, (x, y) => skipsSerial.push(`${x}|${y}`), { batch: false });
  assert.deepEqual(batched, serial);
  assert.deepEqual(skipsBatch, skipsSerial);
  assert.ok(batched.some((c) => c.prA === 'a' && c.prB === 'b'), 'a/b collide');
  assert.ok(skipsBatch.some((s) => s.includes('island')), 'unrelated history skipped with a reason');
  assert.ok(skipsBatch.some((s) => s.includes('no-such-branch')), 'unresolvable ref skipped');
});

test('mergeTreeBatch refuses non-oid input instead of passing it to git', () => {
  const repo = makeRepo();
  const out = mergeTreeBatch(repo, [['--help', 'main']]);
  assert.deepEqual(out, [null]);
  assert.ok(BATCH_CHUNK >= 64);
});

test('mergeTreeConflictedFilesMany falls back per pair after a fatal pair inside a batch', () => {
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'line1\nA\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nB\nline3\nline4\nline5\n' });
  git(repo, ['checkout', '-q', '--orphan', 'island']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'island']);
  git(repo, ['checkout', '-q', 'main']);
  const oid = (r: string): string => git(repo, ['rev-parse', r]);
  const res = mergeTreeConflictedFilesMany(repo, [
    [oid('a'), oid('b')],
    [oid('a'), oid('island')],
    [oid('b'), oid('a')],
  ]);
  assert.deepEqual(res[0], { files: ['file.txt'] });
  assert.ok('error' in (res[1] as object), 'the unrelated pair is an error, not a clean merge');
  assert.deepEqual(res[2], { files: ['file.txt'] }, 'pairs after the fatal one are still answered');
});

/* ---------------------------------- symbols --------------------------------- */

test('extractExports: JS/TS declaration forms, lists, aliases, CommonJS, comments ignored', () => {
  const t = `
// export function commented() {}
/* export const alsoCommented = 1 */
export function a() {}
export async function b() {}
export const c = 1, d = 2;
export class E {}
export type T = string;
export interface I {}
export { x, y as z };
export default function () {}
exports.cjs1 = 1;
module.exports = { m1, m2: foo };
`;
  const got = [...extractExports('js', t)].sort();
  for (const n of ['a', 'b', 'c', 'E', 'T', 'I', 'x', 'z', 'default', 'cjs1', 'm1', 'm2']) assert.ok(got.includes(n), `missing ${n}`);
  assert.ok(!got.includes('commented') && !got.includes('alsoCommented') && !got.includes('y'));
});

test('extractExports: Python top-level defs, classes, constants; private names kept out by caller', () => {
  const got = extractExports('py', 'def f(a):\n    pass\nasync def g():\n    pass\nclass K:\n    def inner(self): pass\nLIMIT = 3\n    nested = 1\n');
  assert.deepEqual([...got].sort(), ['K', 'LIMIT', 'f', 'g']);
});

test('extractImports/resolveImport: named, aliased, namespace, require, relative resolution, no node_modules guesses', () => {
  const imps = extractImports('js', `import { a, b as bb } from './lib.js';\nimport * as ns from "../x";\nimport def from './d';\nconst { q: qq } = require('./cjs');\nimport left from 'react';\nexport { r } from './re';`);
  const bySpec = Object.fromEntries(imps.map((i) => [i.spec, i]));
  assert.deepEqual(bySpec['./lib.js']!.named, [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'bb' }]);
  assert.equal(bySpec['../x']!.namespace, 'ns');
  assert.deepEqual(bySpec['./d']!.named, [{ imported: 'default', local: 'default' }]);
  assert.deepEqual(bySpec['./cjs']!.named, [{ imported: 'q', local: 'qq' }]);
  assert.deepEqual(bySpec['./re']!.named, [{ imported: 'r', local: 'r' }]);
  const files = new Set(['src/lib.ts', 'src/util/index.js', 'src/x.mjs', 'pkg/a/b.py', 'pkg/a/__init__.py', 'pkg/c.py']);
  assert.equal(resolveImport('js', 'src/app.ts', './lib.js', files), 'src/lib.ts', 'TS imports ./x.js for x.ts');
  assert.equal(resolveImport('js', 'src/app.ts', './util', files), 'src/util/index.js');
  assert.equal(resolveImport('js', 'src/app.ts', './x', files), 'src/x.mjs');
  assert.equal(resolveImport('js', 'src/app.ts', 'react', files), null);
  assert.equal(resolveImport('js', 'src/app.ts', '../../../../etc/passwd', files), null, 'cannot climb out of the repo');
  assert.equal(resolveImport('py', 'pkg/c.py', '.a.b', files), 'pkg/a/b.py');
  assert.equal(resolveImport('py', 'pkg/a/b.py', '..c', files), 'pkg/c.py');
  assert.equal(resolveImport('py', 'main.py', 'pkg.c', files), 'pkg/c.py');
  assert.equal(resolveImport('py', 'main.py', 'os.path', files), null);
});

test('mentionsIdentifier/mentionsMember do not match substrings or other objects', () => {
  assert.equal(mentionsIdentifier('const r = gone(1);', 'gone'), true);
  assert.equal(mentionsIdentifier('const r = undergone(1);', 'gone'), false);
  assert.equal(mentionsIdentifier('obj.gone(1)', 'gone'), false);
  assert.equal(mentionsMember('lib.gone(1)', 'lib', 'gone'), true);
  assert.equal(mentionsMember('xlib.gone(1)', 'lib', 'gone'), false);
  assert.equal(mentionsIdentifier('x', 'not an ident!'), false);
  assert.equal(langOf('a/b.d.ts'), null);
  assert.equal(langOf('a/b.tsx'), 'js');
  assert.equal(langOf('a/b.PY'), 'py');
});

test('symbol regexes stay linear on adversarial input', () => {
  const evil = 'import {' + ' a,'.repeat(20000) + ' from "x"\n' + 'export const ' + 'a'.repeat(200000) + '\n' + '/*'.repeat(50000);
  const t0 = Date.now();
  extractExports('js', evil);
  extractImports('js', evil);
  extractImports('py', 'from ' + '.'.repeat(100000) + ' import ' + 'x, '.repeat(30000));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

/* ------------------------------ deep forecast ------------------------------- */

function refsOf(repo: string, names: string[]) {
  return names.map((n) => ({ label: n, oid: git(repo, ['rev-parse', n]) }));
}

test('semantic: a removed export still used by the other branch\'s NEW code is flagged (clean merge, broken result)', () => {
  const repo = jsRepo();
  // remover deletes `gone` from lib.js; adder writes a new caller of `gone` in other.js
  makeBranch(repo, 'remover', { 'src/lib.js': 'export function keep(x) {\n  return x;\n}\n' });
  makeBranch(repo, 'adder', { 'src/other.js': "import { gone } from './lib.js';\nexport const other = () => gone(2);\n" });
  assert.equal(textualCollisions(repo, ['remover', 'adder']).length, 0, 'merge-tree alone sees nothing');
  const { collisions } = deepForecast(repo, refsOf(repo, ['remover', 'adder']), { semantic: true });
  assert.equal(collisions.length, 1);
  const c = collisions[0]!;
  assert.equal(c.severity, 'semantic');
  assert.equal(c.confidence, 'high');
  assert.deepEqual(c.files, ['src/lib.js', 'src/other.js']);
  assert.match(c.detail ?? '', /remover removed gone from src\/lib\.js; adder adds code in src\/other\.js/);
});

test('semantic: aliased import, namespace use, deleted file, and both directions', () => {
  const repo = jsRepo();
  makeBranch(repo, 'remover', { 'src/lib.js': 'export function keep(x) {\n  return x;\n}\n' });
  makeBranch(repo, 'alias', { 'src/other.js': "import { gone as g } from './lib.js';\nexport const o = () => g(2);\n" });
  makeBranch(repo, 'ns', { 'src/other.js': "import * as lib from './lib.js';\nexport const o = () => lib.gone(2);\n" });
  for (const adder of ['alias', 'ns']) {
    const r = deepForecast(repo, refsOf(repo, [adder, 'remover']), { semantic: true });
    assert.equal(r.collisions.length, 1, adder);
    assert.equal(r.collisions[0]!.prA, 'remover', 'the remover is reported as side A regardless of argument order');
  }
  git(repo, ['checkout', '-q', '-b', 'deleter', 'main']);
  git(repo, ['rm', '-q', 'src/lib.js']);
  git(repo, ['commit', '-qm', 'delete lib']);
  git(repo, ['checkout', '-q', 'main']);
  const r2 = deepForecast(repo, refsOf(repo, ['alias', 'deleter']), { semantic: true });
  assert.equal(r2.collisions.length, 1, 'deleting the module removes all its exports');
});

test('semantic: no false alarm when the other branch only keeps old usages, uses another name, or does not import the file', () => {
  const repo = jsRepo();
  makeBranch(repo, 'remover', { 'src/lib.js': 'export function keep(x) {\n  return x;\n}\n' });
  makeBranch(repo, 'uses-keep', { 'src/other.js': "import { keep } from './lib.js';\nexport const o = () => keep(2);\n" });
  makeBranch(repo, 'mentions-only-in-string', { 'src/other.js': "export const o = 'gone is a word';\nexport const gone = 1;\n" });
  makeBranch(repo, 'own-gone', { 'src/other.js': 'export function gone() {}\nexport const x = () => gone();\n' });
  for (const b of ['uses-keep', 'mentions-only-in-string', 'own-gone']) {
    assert.deepEqual(deepForecast(repo, refsOf(repo, ['remover', b]), { semantic: true }).collisions, [], b);
  }
});

test('overlap: same file, clean merge -> overlap; textual conflicts are not double-reported', () => {
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'AAA\nline2\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nline2\nline3\nline4\nBBB\n' });
  makeBranch(repo, 'c', { 'file.txt': 'AAA2\nline2\nline3\nline4\nline5\n' });
  const o = deepForecast(repo, refsOf(repo, ['a', 'b']), { overlap: true });
  assert.equal(o.collisions.length, 1);
  assert.equal(o.collisions[0]!.severity, 'overlap');
  const textual = new Map([[`a\0c`, ['file.txt']]]);
  assert.deepEqual(deepForecast(repo, refsOf(repo, ['a', 'c']), { overlap: true, textual }).collisions, []);
});

test('neighbors: import edge between changed files is a low-confidence semantic finding, off by default', () => {
  const repo = jsRepo();
  makeBranch(repo, 'lib-edit', { 'src/lib.js': 'export function keep(x) {\n  return x * 2;\n}\n\nexport function gone(x) {\n  return x + 1;\n}\n' });
  makeBranch(repo, 'app-edit', { 'src/app.js': "import { keep } from './lib.js';\nexport const app = () => keep(5);\n" });
  const refs = refsOf(repo, ['lib-edit', 'app-edit']);
  assert.deepEqual(deepForecast(repo, refs, { semantic: true }).collisions, []);
  const n = deepForecast(repo, refs, { neighbors: true }).collisions;
  assert.equal(n.length, 1);
  assert.equal(n[0]!.confidence, 'low');
  assert.match(n[0]!.detail ?? '', /src\/app\.js imports src\/lib\.js/);
});

test('python: removed function used by a new `from pkg.lib import` in the other branch', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'pkg', '__init__.py'), '');
  writeFileSync(join(repo, 'pkg', 'lib.py'), 'def keep(x):\n    return x\n\n\ndef gone(x):\n    return x + 1\n');
  writeFileSync(join(repo, 'pkg', 'mod.py'), 'X = 1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'py']);
  makeBranch(repo, 'remover', { 'pkg/lib.py': 'def keep(x):\n    return x\n' });
  makeBranch(repo, 'adder', { 'pkg/mod.py': 'from .lib import gone as g\n\ndef f():\n    return g(1)\n' });
  const c = deepForecast(repo, refsOf(repo, ['remover', 'adder']), { semantic: true }).collisions;
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.files, ['pkg/lib.py', 'pkg/mod.py']);
});

test('deep forecast is hostile-input safe: weird file names, binary and oversized sources', () => {
  const repo = jsRepo();
  git(repo, ['checkout', '-q', '-b', 'weird', 'main']);
  writeFileSync(join(repo, 'src', 'we ird\nname.js'), "import { gone } from './lib.js';\nexport const w = gone;\n");
  writeFileSync(join(repo, 'src', 'blob.js'), Buffer.from([0x69, 0x6d, 0x70, 0x00, 0xff, 0xfe]));
  writeFileSync(join(repo, 'src', 'huge.js'), 'export const h = 1;\n' + '// x\n'.repeat(200_000));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'weird']);
  git(repo, ['checkout', '-q', 'main']);
  makeBranch(repo, 'remover', { 'src/lib.js': 'export function keep(x) {\n  return x;\n}\n' });
  const r = deepForecast(repo, refsOf(repo, ['remover', 'weird']), { semantic: true, overlap: true });
  assert.equal(r.collisions.length, 1);
  assert.deepEqual(r.collisions[0]!.files, ['src/lib.js', 'src/we ird\nname.js']);
});

test('parseRawDiff and addedLines', () => {
  const raw = `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0a b.js\0:000000 100644 ${'0'.repeat(40)} ${'3'.repeat(40)} A\0n.js\0`;
  const ch = parseRawDiff(raw);
  assert.deepEqual(ch.map((c) => [c.status, c.path]), [['M', 'a b.js'], ['A', 'n.js']]);
  assert.equal(addedLines('a\nb\nb\n', 'a\nb\nb\nb\nc\n'), 'b\nc');
  assert.equal(addedLines('a\n', 'a\n\n   \n'), '');
});

/* ------------------------------ lockfiles/generated -------------------------- */

test('regenerable: lockfile-only collisions are marked with a fix, mixed ones are not', () => {
  assert.equal(isRegenerable('web/package-lock.json'), true);
  assert.equal(isRegenerable('src/app.ts'), false);
  assert.match(regenHint(['package-lock.json'])!, /npm install/);
  assert.equal(regenHint(['package-lock.json', 'src/app.ts']), null);
  assert.equal(regenHint([]), null);
  const cs = annotateRegenerable([
    { prA: 'a', prB: 'b', files: ['yarn.lock', 'pnpm-lock.yaml'], severity: 'textual' },
    { prA: 'a', prB: 'c', files: ['yarn.lock', 'src/x.ts'], severity: 'textual' },
    { prA: 'a', prB: 'd', files: ['yarn.lock'], severity: 'intent' },
  ]);
  assert.equal(cs[0]!.regenerable, true);
  assert.equal(cs[1]!.regenerable, undefined);
  assert.equal(cs[2]!.regenerable, undefined, 'only textual collisions are regenerable');
});

test('conflicts --exit-code --ignore-regenerable: lockfile-only conflict exits 0, real conflict exits 2', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package-lock.json'), '{\n"a": 1,\n"b": 2,\n"c": 3\n}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'lock']);
  makeBranch(repo, 'a', { 'package-lock.json': '{\n"a": 11,\n"b": 2,\n"c": 3\n}\n' });
  makeBranch(repo, 'b', { 'package-lock.json': '{\n"a": 12,\n"b": 2,\n"c": 3\n}\n' });
  const env = { CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  const plain = cli(['conflicts', '--exit-code'], { cwd: repo, env });
  assert.equal(plain.code, 2);
  assert.match(plain.stdout, /regenerable/);
  assert.match(plain.stdout, /npm install/);
  assert.equal(cli(['conflicts', '--exit-code', '--ignore-regenerable'], { cwd: repo, env }).code, 0);
  makeBranch(repo, 'c', { 'file.txt': 'X\nline2\nline3\nline4\nline5\n' });
  makeBranch(repo, 'd', { 'file.txt': 'Y\nline2\nline3\nline4\nline5\n' });
  assert.equal(cli(['conflicts', '--exit-code', '--ignore-regenerable'], { cwd: repo, env }).code, 2);
});

test('conflicts --deep through the CLI (branches) finds the semantic break; JSON carries confidence', () => {
  const repo = jsRepo();
  makeBranch(repo, 'remover', { 'src/lib.js': 'export function keep(x) {\n  return x;\n}\n' });
  makeBranch(repo, 'adder', { 'src/other.js': "import { gone } from './lib.js';\nexport const other = () => gone(2);\n" });
  const env = { CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  const plain = JSON.parse(cli(['conflicts', '--json'], { cwd: repo, env }).stdout);
  assert.equal(plain.collisionCount, 0);
  const deep = JSON.parse(cli(['conflicts', '--deep', '--json'], { cwd: repo, env }).stdout);
  assert.equal(deep.collisionCount, 1);
  assert.equal(deep.collisions[0].severity, 'semantic');
  assert.equal(deep.collisions[0].confidence, 'high');
  const text = cli(['conflicts', '--deep'], { cwd: repo, env }).stdout;
  assert.match(text, /\[SEMANTIC, high confidence\]/);
});

test('conflicts --worktrees --deep: uncommitted removal vs uncommitted new use', () => {
  const repo = jsRepo();
  const base = tempDir('cf-e2-wt-');
  const a = join(base, 'a');
  const b = join(base, 'b');
  git(repo, ['worktree', 'add', '-q', '-b', 'wa', a, 'main']);
  git(repo, ['worktree', 'add', '-q', '-b', 'wb', b, 'main']);
  writeFileSync(join(a, 'src', 'lib.js'), 'export function keep(x) {\n  return x;\n}\n');
  writeFileSync(join(b, 'src', 'other.js'), "import { gone } from './lib.js';\nexport const other = () => gone(2);\n");
  const env = { CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  const out = JSON.parse(cli(['conflicts', '--worktrees', '--deep', '--json'], { cwd: repo, env }).stdout);
  assert.equal(out.collisions.filter((c: { severity: string }) => c.severity === 'semantic').length, 1);
});

/* ---------------------- shared ledger across worktrees ---------------------- */

test('agents in different worktrees see each other with NO remote (ledger lives in the common git dir)', () => {
  const repo = makeRepo();
  const wt = join(tempDir('cf-e2-wt-'), 'second');
  git(repo, ['worktree', 'add', '-q', '-b', 'second', wt, 'main']);
  const env = { CEASEFIRE_SYNC: '0' } as Record<string, string>;
  const noDir = { ...process.env } as Record<string, string | undefined>;
  delete noDir['CEASEFIRE_DIR'];
  const run = (cwd: string, agent: string, args: string[]) =>
    spawnSync('node', [CLI, ...args], { cwd, env: { ...noDir, ...env, CEASEFIRE_AGENT: agent } as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(run(repo, 'builder', ['start', 'x', '--paths', 'file.txt']).status, 0);
  const r = run(wt, 'reviewer', ['check', 'file.txt']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /builder/);
  const savedDir = process.env.CEASEFIRE_DIR;
  delete process.env.CEASEFIRE_DIR;
  try {
    assert.equal(resolveStoreDir(repo), resolveStoreDir(wt));
    assert.match(resolveStoreDir(wt), /\.git[\\/]ceasefire$/);
  } finally {
    if (savedDir !== undefined) process.env.CEASEFIRE_DIR = savedDir;
  }
});

/* ------------------------------ auto-lease + hook --------------------------- */

test('touchLease: creates once, adds paths, slides the expiry, expires without cleanup, caps paths', () => {
  const dir = tempDir('cf-e2-lease-');
  const s = new IntentStore(join(dir, 'intents.db'));
  const t0 = 1_000_000;
  const first = s.touchLease('a.ts', { agent: 'x', branch: 'b', ttlMs: 60_000, now: t0 });
  assert.equal(first.created, true);
  assert.equal(first.intent.task, AUTO_LEASE_TASK);
  const second = s.touchLease('c.ts', { agent: 'x', branch: 'b', ttlMs: 60_000, now: t0 + 30_000 });
  assert.equal(second.created, false);
  assert.equal(second.pathAdded, true);
  assert.deepEqual(second.intent.paths, ['a.ts', 'c.ts']);
  assert.equal(second.intent.expiresAt, t0 + 90_000, 'sliding ttl');
  assert.equal(s.touchLease('c.ts', { agent: 'x', branch: 'b', ttlMs: 60_000, now: t0 + 31_000 }).pathAdded, false);
  assert.equal(s.list({ status: 'active', now: t0 + 100_000 }).length, 0, 'a crashed session stops holding files after the ttl');
  const again = s.touchLease('z.ts', { agent: 'x', branch: 'b', ttlMs: 60_000, now: t0 + 200_000 });
  assert.equal(again.created, true, 'an expired lease is replaced, not revived');
  for (let i = 0; i < 10; i++) s.touchLease(`f${i}.ts`, { agent: 'y', branch: 'b', ttlMs: 60_000, now: t0, maxPaths: 4 });
  assert.deepEqual(s.list({ agent: 'y' })[0]!.paths, ['f6.ts', 'f7.ts', 'f8.ts', 'f9.ts']);
  assert.throws(() => s.touchLease('p', { agent: ' ', branch: 'b', ttlMs: 1 }));
  assert.throws(() => s.touchLease('p', { agent: 'x', branch: 'b', ttlMs: 0 }));
  s.close();
});

test('touchLease: parallel processes never lose a path', () => {
  const dir = tempDir('cf-e2-lease-');
  const db = join(dir, 'intents.db');
  new IntentStore(db).close();
  const storeUrl = new URL('../src/intent/store.js', import.meta.url).href;
  const script = `const { IntentStore } = await import(${JSON.stringify(storeUrl)});
    const s = new IntentStore(${JSON.stringify(db)});
    for (let i = 0; i < 15; i++) s.touchLease(process.argv[1] + '-' + i, { agent: 'p', branch: 'b', ttlMs: 600000 });
    s.close();`;
  const procs = ['a', 'b', 'c', 'd'].map((n) => spawnSync('node', ['--no-warnings', '--input-type=module', '-e', script, n], { encoding: 'utf8' }));
  procs.forEach((p) => assert.equal(p.status, 0, p.stderr));
  const s = new IntentStore(db);
  const all = s.list({ agent: 'p', status: 'active' });
  assert.equal(all.length, 1, 'one lease');
  assert.equal(all[0]!.paths.length, 60);
  s.close();
});

function hookEvent(repoDir: string, sid: string, file: string, tool = 'Edit') {
  return JSON.stringify({ session_id: sid, cwd: repoDir, tool_name: tool, tool_input: { file_path: join(repoDir, file) } });
}

test('hook --claim: two sessions of ONE os user collide through their session ids; release frees the file', () => {
  const repo = makeRepo();
  const wt = join(tempDir('cf-e2-wt-'), 'w2');
  git(repo, ['worktree', 'add', '-q', '-b', 'w2', wt, 'main']);
  const env = { CEASEFIRE_AGENT: '' };
  const a = cli(['hook', 'claude', '--claim'], { cwd: repo, env, input: hookEvent(repo, 'aaaa1111-session', 'file.txt') });
  assert.equal(a.code, 0);
  assert.equal(a.stdout, '', 'first editor: clear, silent');
  const b = cli(['hook', 'claude', '--claim'], { cwd: wt, env, input: hookEvent(wt, 'bbbb2222-session', 'file.txt') });
  const out = JSON.parse(b.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /claude-bbbb|claude-aaaa/);
  assert.match(out.hookSpecificOutput.additionalContext, /file\.txt/);
  const rel = cli(['hook', 'release'], { cwd: repo, env, input: hookEvent(repo, 'aaaa1111-session', 'file.txt') });
  assert.equal(rel.code, 0);
  const c = cli(['hook', 'claude'], { cwd: wt, env: { CEASEFIRE_AGENT: 'someone-else' }, input: hookEvent(wt, 'cccc3333-session', 'file.txt') });
  assert.doesNotMatch(c.stdout, /aaaa1111/, 'released lease no longer contends');
});

test('hook: explicit CEASEFIRE_AGENT wins over the session id; without --claim nothing is leased', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_AGENT: 'named-agent', CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  cli(['hook', 'claude'], { cwd: repo, env, input: hookEvent(repo, 'aaaa1111-session', 'file.txt') });
  assert.match(cli(['list'], { cwd: repo, env }).stdout, /no active intents/);
  cli(['hook', 'claude', '--claim'], { cwd: repo, env, input: hookEvent(repo, 'aaaa1111-session', 'file.txt') });
  const l = cli(['list', '--json'], { cwd: repo, env }).stdout;
  assert.equal(JSON.parse(l).intents[0].agent, 'named-agent');
});

test('hook --claim in strict mode: a denied edit does not take the lease; unsafe session ids are ignored', () => {
  const repo = makeRepo();
  const store = tempDir('cf-e2-store-');
  const holder = cli(['start', 'hold', '--paths', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'holder', CEASEFIRE_DIR: store } });
  assert.equal(holder.code, 0);
  const env = { CEASEFIRE_AGENT: '', CEASEFIRE_DIR: store, CEASEFIRE_STRICT: '1' };
  const r = cli(['hook', 'claude', '--claim'], { cwd: repo, env, input: hookEvent(repo, 'dddd4444-evil', 'file.txt') });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const list = JSON.parse(cli(['list', '--json'], { cwd: repo, env: { CEASEFIRE_DIR: store } }).stdout).intents;
  assert.equal(list.length, 1, 'only the holder');
  const bad = runClaudeHook(hookEvent(repo, "x'; DROP TABLE intents;--", 'other.txt'), { ask: false });
  assert.ok(bad.exitCode === 0 || bad.exitCode === 1);
});

test('claimLease / releaseLeases / runReleaseHook API', () => {
  const repo = makeRepo();
  const prevDir = process.env.CEASEFIRE_DIR;
  const prevAgent = process.env.CEASEFIRE_AGENT;
  const prevSync = process.env.CEASEFIRE_SYNC;
  process.env.CEASEFIRE_DIR = tempDir('cf-e2-store-');
  process.env.CEASEFIRE_AGENT = 'api-agent';
  process.env.CEASEFIRE_SYNC = '0';
  try {
    const ctx = { cwd: repo, json: true };
    assert.equal(claimLease(ctx, []), null);
    const l = claimLease(ctx, ['file.txt', 'other.txt'])!;
    assert.deepEqual(l.paths, ['file.txt', 'other.txt']);
    assert.equal(JSON.parse(cmdStatus(ctx).stdout).agents.length, 1);
    assert.equal(releaseLeases(ctx), 1);
    assert.equal(releaseLeases(ctx), 0);
    assert.equal(runReleaseHook('not json').exitCode, 0, 'release is best-effort and never fails the session end');
  } finally {
    for (const [k, v] of [['CEASEFIRE_DIR', prevDir], ['CEASEFIRE_AGENT', prevAgent], ['CEASEFIRE_SYNC', prevSync]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('done --all completes every intent of the agent', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_AGENT: 'multi', CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  cli(['start', 'one', '--paths', 'file.txt'], { cwd: repo, env });
  cli(['start', 'two', '--paths', 'other.txt'], { cwd: repo, env });
  assert.equal(cli(['done'], { cwd: repo, env }).code, 1, 'ambiguous without --all');
  const r = cli(['done', '--all'], { cwd: repo, env });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /completed 2/);
  assert.match(cli(['list'], { cwd: repo, env }).stdout, /no active intents/);
  assert.equal(cli(['done', '--all', '--id', 'x'], { cwd: repo, env }).code, 1);
});

/* ---------------------------------- status ---------------------------------- */

test('status: idle, held, contested, oneline, json; text is sanitized', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_DIR: tempDir('cf-e2-store-') };
  assert.match(cli(['status'], { cwd: repo, env }).stdout, /idle/);
  cli(['start', 't1', '--paths', 'file.txt'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'bui\u202Elder' } });
  assert.match(cli(['status', '--oneline'], { cwd: repo, env }).stdout, /1 agent editing, 1 path held$/m);
  cli(['start', 't2', '--paths', 'file.txt'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'reviewer' } });
  const text = cli(['status'], { cwd: repo, env }).stdout;
  assert.match(text, /2 agents editing, 1 path held, 1 file CONTESTED/);
  assert.match(text, /Contested/);
  assert.doesNotMatch(text, /\u202E/, 'bidi override never reaches the terminal');
  const j = JSON.parse(cli(['status', '--json'], { cwd: repo, env }).stdout);
  assert.equal(j.agents.length, 2);
  assert.equal(j.contested.length, 1);
  assert.equal(cli(['status', 'extra'], { cwd: repo, env }).code, 1);
  assert.equal(cli(['status'], { cwd: tempDir('cf-e2-nogit-'), env }).code, 1);
});

/* ---------------------------------- init ------------------------------------ */

test('init --claude adds auto-lease hook + SessionEnd release; --statusline only fills an empty slot; upgrade path adds SessionEnd', () => {
  const repo = makeRepo();
  const r = installClaudeHook(repo, { statusline: true });
  assert.equal(r.ok, true);
  const s = JSON.parse(require_read(join(repo, '.claude', 'settings.json')));
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'ceasefire hook claude --claim');
  assert.equal(s.hooks.SessionEnd[0].hooks[0].command, 'ceasefire hook release');
  assert.equal(s.statusLine.command, 'ceasefire status --oneline');
  assert.match(installClaudeHook(repo, { statusline: true }).note, /already present/);
  // an existing status line is never replaced
  const repo2 = makeRepo();
  mkdirSync(join(repo2, '.claude'), { recursive: true });
  writeFileSync(join(repo2, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'ceasefire hook claude' }] }] } }));
  const note = installClaudeHook(repo2, { statusline: true }).note;
  assert.match(note, /left alone/);
  const s2 = JSON.parse(require_read(join(repo2, '.claude', 'settings.json')));
  assert.equal(s2.statusLine.command, 'mine');
  assert.equal(s2.hooks.SessionEnd[0].hooks[0].command, 'ceasefire hook release', 'older installs gain the release hook');
  assert.equal(s2.hooks.PreToolUse.length, 1, 'old PreToolUse entry untouched, not duplicated');
});

test('cmdConflicts API: --overlap alone reports overlap, regenerable annotation present in JSON', () => {
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'AAA\nline2\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nline2\nline3\nline4\nBBB\n' });
  const prev = process.env.CEASEFIRE_DIR;
  process.env.CEASEFIRE_DIR = tempDir('cf-e2-store-');
  try {
    const r = cmdConflicts({ cwd: repo, json: true }, Date.now(), { overlap: true });
    const j = JSON.parse(r.stdout);
    assert.equal(j.collisions[0].severity, 'overlap');
    assert.equal(cmdConflicts({ cwd: repo, json: true }).stdout.includes('overlap'), false, 'default output unchanged');
  } finally {
    if (prev === undefined) delete process.env.CEASEFIRE_DIR;
    else process.env.CEASEFIRE_DIR = prev;
  }
});

import { readFileSync } from 'node:fs';
function require_read(p: string): string {
  return readFileSync(p, 'utf8');
}
