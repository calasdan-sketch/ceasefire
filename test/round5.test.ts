/** Expert round 5: author line, directory/file conflict names, differential and property tests, golden output. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { posix as pposix } from 'node:path';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, makeRepo, makeBranch, tempDir } from './helpers.js';
import { AUTHOR } from '../src/version.js';
import { cleanConflictPath, parseMergeTreeStdin } from '../src/forecast/batch.js';
import { textualCollisions } from '../src/forecast/forecast.js';
import { globMatch, escapeGlob, fileMatchesClaim, normalizePath, pathsOverlap } from '../src/forecast/paths.js';
import { unquoteGitPath } from '../src/cli/gitquote.js';
import { canonicalizePath, PathOutsideRepoError } from '../src/forecast/paths.js';
import { cleanGitEnv } from '../src/forecast/git.js';
import { loadCoreForecast } from '../src/github/forecast.js';
import { renderCollisionComment, deriveVerdict } from '../src/github/comment.js';
import { formatBlockedMessage, formatClearMessage } from '../src/cli/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const OWNER = 'Calas Automations Inc.';
const WIN = process.platform === 'win32';

/** Small seeded generator (mulberry32) so a failure names the seed that reproduces it. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* author line                                                         */
/* ------------------------------------------------------------------ */

test('author: the owner string is exactly "Calas Automations Inc." in every place that carries one', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg['author'], OWNER);
  assert.equal(AUTHOR, OWNER, 'the code reads the same string package.json carries');
  assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^Copyright \(c\) 2026 Calas Automations Inc\.$/m);
  assert.match(readFileSync(join(ROOT, 'src', 'github', 'action.yml'), 'utf8'), /^author: 'Calas Automations Inc\.'$/m);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /^Maintained by Calas Automations Inc\. · MIT license$/m);
  // The old handle must not be used as an author label anywhere in the shipped metadata.
  assert.ok(!/calasdan|decnutz|Dan Calas/i.test(String(pkg['author'])));
});

test('author: the file that npm would publish carries the owner string', { skip: WIN ? 'runs npm without a shell' : false }, () => {
  const out = tempDir('cf-pack-');
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out, '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const tgz = readdirSync(out).find((f) => f.endsWith('.tgz')) as string;
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', join(out, tgz), 'package/package.json'], { encoding: 'utf8' })) as Record<string, unknown>;
  assert.equal(manifest['author'], OWNER);
  const license = execFileSync('tar', ['-xzOf', join(out, tgz), 'package/LICENSE'], { encoding: 'utf8' });
  assert.match(license, /Copyright \(c\) 2026 Calas Automations Inc\./);
});

test('version: package.json, CHANGELOG heading and --version agree', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.match(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}\\b`, 'm'));
  assert.equal(spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).stdout.trim(), `ceasefire ${pkg.version}`);
});

/* ------------------------------------------------------------------ */
/* packaging / platform hygiene                                        */
/* ------------------------------------------------------------------ */

test('scripts: npm scripts use no POSIX-only shell syntax (they must run from cmd.exe)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.ok(!/(^|[\s&|;])rm\s|mkdir\s+-p|^\s*[A-Z_]+=\S+\s|\$PWD|\$\(/.test(cmd), `scripts.${name} is portable: ${cmd}`);
  }
  assert.ok(existsSync(join(ROOT, 'scripts', 'test.mjs')));
});

test('git attributes: text files are checked out with LF so the CLI shebang survives a Windows checkout', () => {
  const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\* text=auto eol=lf$/m);
});

/* ------------------------------------------------------------------ */
/* directory/file conflicts name a real path                           */
/* ------------------------------------------------------------------ */

test('cleanConflictPath strips only a full object-id suffix', () => {
  const oid = 'a'.repeat(40);
  assert.equal(cleanConflictPath(`d~${oid}`), 'd');
  assert.equal(cleanConflictPath(`src/d~${oid}${'b'.repeat(24)}`), 'src/d');
  assert.equal(cleanConflictPath('backup~1'), 'backup~1');
  assert.equal(cleanConflictPath(`d~${'a'.repeat(39)}`), `d~${'a'.repeat(39)}`);
  assert.equal(cleanConflictPath('plain.txt'), 'plain.txt');
  assert.deepEqual(parseMergeTreeStdin(`0\0${oid}\0d~${oid}\0d\0\0`, 1), [['d']]);
});

test('a directory/file conflict is reported under the path the agents touched, batched or not', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'lib'));
  writeFileSync(join(repo, 'lib', 'x.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'lib']);
  git(repo, ['checkout', '-qb', 'asfile', 'main']);
  rmSync(join(repo, 'lib'), { recursive: true });
  writeFileSync(join(repo, 'lib'), 'now a file\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'file']);
  git(repo, ['checkout', '-qb', 'asdir', 'main']);
  writeFileSync(join(repo, 'lib', 'y.txt'), 'y\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'dir']);
  git(repo, ['checkout', '-q', 'main']);
  for (const batch of [true, false]) {
    const cs = textualCollisions(repo, ['asfile', 'asdir'], undefined, { batch });
    assert.equal(cs.length, 1, `batch=${batch}`);
    assert.ok(cs[0]!.files.every((f) => !/~[0-9a-f]{40}/.test(f)), `no object-id suffix: ${cs[0]!.files.join(',')}`);
    assert.ok(cs[0]!.files.includes('lib'));
  }
});

/* ------------------------------------------------------------------ */
/* fail closed: a pair that cannot be forecast is never reported "clear" */
/* ------------------------------------------------------------------ */

function cliIn(repo: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_JSON: '' }, encoding: 'utf8', input: '' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test('unrelated histories (an orphan branch such as gh-pages): reported in --json, warned, and does not fail a CI gate', () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-q', '--orphan', 'gh-pages']);
  git(repo, ['rm', '-rqf', '.']);
  writeFileSync(join(repo, 'index.html'), '<p>hi</p>\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'pages']);
  git(repo, ['checkout', '-q', 'main']);
  for (const batch of [true, false]) {
    const skipped: string[] = [];
    assert.deepEqual(textualCollisions(repo, ['main', 'gh-pages'], (a, b, why) => skipped.push(`${a}|${b}|${why}`), { batch }), []);
    assert.equal(skipped.length, 1, `batch=${batch}: the pair is reported as skipped, not silently clear`);
  }
  const gate = cliIn(repo, ['conflicts', '--exit-code']);
  assert.equal(gate.code, 0);
  assert.match(gate.stdout, /1 could not be checked/);
  const json = JSON.parse(cliIn(repo, ['conflicts', '--json']).stdout) as { unchecked: Array<{ expected: boolean }> };
  assert.equal(json.unchecked.length, 1);
  assert.equal(json.unchecked[0]!.expected, true);
});

test('a pair git cannot merge for any other reason makes `conflicts --exit-code` exit 1, not 0', () => {
  const repo = makeRepo();
  makeBranch(repo, 'x', { 'file.txt': 'line1\nX\nline3\nline4\nline5\n' });
  makeBranch(repo, 'y', { 'file.txt': 'line1\nY\nline3\nline4\nline5\n' });
  const blob = git(repo, ['rev-parse', 'x:file.txt']);
  rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
  const gate = cliIn(repo, ['conflicts', '--exit-code']);
  assert.equal(gate.code, 1, gate.stderr);
  assert.match(gate.stderr, /cannot be promised/);
  assert.equal(cliIn(repo, ['conflicts']).code, 0, 'without --exit-code it stays a warning');
});

test('a shallow clone never passes the gate as "clear" (missing history looks like unrelated histories)', () => {
  const origin = makeRepo();
  makeBranch(origin, 'a', { 'file.txt': 'line1\nA\nline3\nline4\nline5\n' });
  makeBranch(origin, 'b', { 'file.txt': 'line1\nB\nline3\nline4\nline5\n' });
  const dest = join(tempDir('cf-shallow-'), 'clone');
  git(dirname(dest), ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${origin}`, dest]);
  for (const b of ['a', 'b']) git(dest, ['branch', '-q', b, `origin/${b}`]);
  const gate = cliIn(dest, ['conflicts', '--exit-code']);
  assert.equal(gate.code, 1, gate.stdout + gate.stderr);
  assert.match(gate.stderr, /shallow clone/);
  assert.match(gate.stderr, /git fetch --unshallow/);
  assert.ok(!/ceasefire: ceasefire:/.test(gate.stderr), 'no doubled prefix');
  const json = JSON.parse(cliIn(dest, ['conflicts', '--json']).stdout) as { unchecked: Array<{ expected: boolean }> };
  assert.ok(json.unchecked.length >= 1 && json.unchecked.every((u) => !u.expected));
});

test('a bare repository gets a plain explanation instead of "not a git repository"', () => {
  const origin = makeRepo();
  const bare = join(tempDir('cf-bare-'), 'r.git');
  git(dirname(bare), ['clone', '-q', '--bare', origin, bare]);
  const r = cliIn(bare, ['conflicts']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bare repository/);
});

test('a clone with only remote-tracking branches says so instead of "no collisions across 1 branch"', () => {
  const origin = makeRepo();
  makeBranch(origin, 'a', { 'file.txt': 'line1\nA\nline3\nline4\nline5\n' });
  const dest = join(tempDir('cf-remote-'), 'clone');
  git(dirname(dest), ['clone', '-q', `file://${origin}`, dest]);
  const r = cliIn(dest, ['conflicts']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /remote-tracking branch\(es\) are not/);
});

test('doctor warns about a shallow clone', () => {
  const origin = makeRepo();
  const dest = join(tempDir('cf-doctor-'), 'clone');
  git(dirname(dest), ['clone', '-q', '--depth', '1', `file://${origin}`, dest]);
  assert.match(cliIn(dest, ['doctor']).stdout, /history[^\n]*shallow clone/);
});

test('git runs with messages in English, whatever the user\'s language, because ceasefire reads a few of them', () => {
  const env = cleanGitEnv({}, { LANG: 'de_DE.UTF-8', LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8', PATH: '/bin' });
  assert.equal(env['LC_ALL'], 'C');
  assert.equal(env['LANGUAGE'], undefined);
  assert.equal(env['PATH'], '/bin');
});

test('property: a truncated or mangled merge-tree stream never yields more conflicts than it contains', () => {
  const oid = (c: string): string => c.repeat(40);
  const records = [`0\0${oid('a')}\0x.ts\0y.ts\0\0`, `1\0${oid('b')}\0\0`, `0\0${oid('c')}\0z.ts\0\0`];
  const full = records.join('');
  assert.deepEqual(parseMergeTreeStdin(full, 3), [['x.ts', 'y.ts'], [], ['z.ts']]);
  const r = rng(99);
  for (let k = 0; k < 400; k++) {
    const cut = Math.floor(r() * full.length);
    const got = parseMergeTreeStdin(full.slice(0, cut), 3);
    // Only complete records are returned, in order, and each equals the real one.
    const complete = records.filter((_, i) => full.slice(0, cut).length >= records.slice(0, i + 1).join('').length).length;
    assert.ok(got.length <= complete, `cut ${cut}: ${got.length} records from ${complete} complete`);
    got.forEach((g, i) => assert.deepEqual(g, parseMergeTreeStdin(full, 3)[i]));
  }
  assert.deepEqual(parseMergeTreeStdin('1\0' + oid('d') + '\0surprise.ts\0\0', 1), [], 'a clean record that lists paths is not the known format');
});

test('check --stdin with 20,000 names answers in a few lines, not 200 KB (an agent reads every byte)', () => {
  const repo = makeRepo();
  const names = Array.from({ length: 20000 }, (_, i) => `dir/file-${i}.ts`).join('\n') + '\n';
  const r = spawnSync(process.execPath, [CLI, 'check', '--stdin'], { cwd: repo, env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'big' }, encoding: 'utf8', input: names });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length < 1500, `answer is ${r.stdout.length} bytes`);
  assert.match(r.stdout, /… and 19980 more/);
  assert.ok(formatClearMessage(['a.ts']).endsWith('a.ts'));
});

test('GitHub Action: a pair the forecast skipped is written to the log as a sanitized workflow warning', async () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-q', '--orphan', 'other']);
  git(repo, ['rm', '-rqf', '.']);
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'orphan']);
  git(repo, ['checkout', '-q', 'main']);
  const impl = await loadCoreForecast();
  const warned: string[] = [];
  const orig = console.log;
  console.log = (m: unknown) => void warned.push(String(m));
  try {
    assert.deepEqual(await impl(repo, ['main', 'other'], [], Date.now()), []);
  } finally {
    console.log = orig;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /^::warning title=ceasefire::could not forecast main <-> other/);
  assert.ok(!/[\r\n]/.test(warned[0]!));
});

test('Windows-style paths: a sibling folder whose name starts like the repo is outside it', () => {
  assert.equal(canonicalizePath('C:\\work\\repo\\src\\a.ts', 'C:\\work\\repo', 'C:\\work\\repo'), 'src/a.ts');
  assert.throws(() => canonicalizePath('C:\\work\\repo-other\\a.ts', 'C:\\work\\repo', 'C:\\work\\repo'), PathOutsideRepoError);
  assert.throws(() => canonicalizePath('c:/work/repository/a.ts', 'C:/work/repo', 'C:/work/repo'), PathOutsideRepoError);
  assert.equal(canonicalizePath('c:/WORK/Repo/Src/a.ts', 'C:/work/repo', 'C:/work/repo'), 'Src/a.ts');
});

/* ------------------------------------------------------------------ */
/* differential test: ceasefire's forecast versus a real `git merge`   */
/* ------------------------------------------------------------------ */

const BASE_FILES: Record<string, string> = {
  'a.txt': Array.from({ length: 12 }, (_, i) => `a${i}`).join('\n') + '\n',
  'b.txt': Array.from({ length: 12 }, (_, i) => `b${i}`).join('\n') + '\n',
  'd/c.txt': 'c\n',
  'e.sh': '#!/bin/sh\necho hi\n',
  'sp ace/f.txt': 'f\n',
  'café.txt': 'u\n',
};

/** One random agent change: edit, delete, rename, add, chmod, binary, directory-to-file, CRLF, unicode name. */
function mutate(dir: string, r: () => number, a: number): string {
  const f = r() < 0.5 ? 'a.txt' : 'b.txt';
  const has = (p: string): boolean => existsSync(join(dir, p));
  switch (Math.floor(r() * 10)) {
    case 0:
      if (has(f)) {
        const l = readFileSync(join(dir, f), 'utf8').split('\n');
        l[Math.floor(r() * 4)] = `edit${a}`;
        writeFileSync(join(dir, f), l.join('\n'));
        return `edit ${f}`;
      }
      break;
    case 1:
      if (has(f)) {
        rmSync(join(dir, f));
        return `delete ${f}`;
      }
      break;
    case 2:
      if (has(f)) {
        renameSync(join(dir, f), join(dir, `moved${a}-${f}`));
        return `rename ${f}`;
      }
      break;
    case 3:
      writeFileSync(join(dir, 'new.txt'), `new${r() < 0.5 ? '' : a}\n`);
      return 'add new.txt';
    case 4:
      if (has('e.sh')) {
        chmodSync(join(dir, 'e.sh'), 0o755);
        return 'chmod e.sh';
      }
      break;
    case 5:
      writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, a, 0]));
      return 'binary';
    case 6:
      if (has('d') && !existsSync(join(dir, 'd', 'z.txt')) && existsSync(join(dir, 'd', 'c.txt'))) {
        rmSync(join(dir, 'd'), { recursive: true });
        writeFileSync(join(dir, 'd'), `now a file ${a}\n`);
        return 'directory becomes file';
      }
      break;
    case 7:
      writeFileSync(join(dir, 'café.txt'), `u${a}\n`);
      return 'edit unicode name';
    case 8:
      writeFileSync(join(dir, 'sp ace', 'f.txt'), `f${a}\n`);
      return 'edit name with space';
    default:
      if (has(f)) {
        writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8').replace(/\n/g, '\r\n'));
        return `crlf ${f}`;
      }
  }
  return 'noop';
}

test('differential: the textual forecast flags exactly the pairs a real `git merge` stops on (seeded histories)', { skip: WIN ? 'uses POSIX file modes' : false }, () => {
  const SEEDS = 10;
  const AGENTS = 4;
  let conflicts = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    const dir = tempDir('cf-diff-');
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'x@y.z']);
    git(dir, ['config', 'user.name', 'x']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    for (const [p, t] of Object.entries(BASE_FILES)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    const names: string[] = [];
    const ops: string[][] = [];
    for (let a = 0; a < AGENTS; a++) {
      git(dir, ['checkout', '-qb', `ag${a}`, 'main']);
      const list: string[] = [];
      for (let k = 0, n = 1 + Math.floor(r() * 2); k < n; k++) list.push(mutate(dir, r, a));
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', `ag${a}`, '--allow-empty']);
      git(dir, ['checkout', '-q', 'main']);
      names.push(`ag${a}`);
      ops.push(list);
    }
    const flagged = new Set<string>();
    for (const c of textualCollisions(dir, names)) {
      flagged.add(`${c.prA}|${c.prB}`);
      flagged.add(`${c.prB}|${c.prA}`);
    }
    for (let i = 0; i < AGENTS; i++) {
      for (let j = i + 1; j < AGENTS; j++) {
        git(dir, ['checkout', '-qf', `ag${i}`]);
        let real = false;
        try {
          git(dir, ['merge', '--no-commit', '--no-ff', '-q', `ag${j}`]);
        } catch {
          real = true;
        }
        spawnSync('git', ['merge', '--abort'], { cwd: dir });
        git(dir, ['reset', '-q', '--hard']);
        if (real) conflicts++;
        assert.equal(flagged.has(`ag${i}|ag${j}`), real, `seed ${seed}, ag${i} vs ag${j}: git says ${real ? 'conflict' : 'clean'}; ops ${JSON.stringify([ops[i], ops[j]])}`);
      }
    }
  }
  assert.ok(conflicts >= 3, `the generator must produce real conflicts to be a test (got ${conflicts})`);
});

/* ------------------------------------------------------------------ */
/* property tests                                                      */
/* ------------------------------------------------------------------ */

test('property: git-quoted names decode back to the real names (compared with git itself)', { skip: WIN ? 'file names with control characters are not valid on Windows' : false }, () => {
  const repo = tempDir('cf-quote-');
  git(repo, ['init', '-q', '-b', 'main']);
  const r = rng(5);
  const alphabet = ['a', 'b', 'Z', '0', ' ', 'é', 'ü', '中', '\u{1F600}', '"', '\\', '\t', '\n', '~', '#', '‮', '\u001b'];
  const names = new Set<string>();
  while (names.size < 60) {
    let n = '';
    for (let k = 1 + Math.floor(r() * 7); k > 0; k--) n += alphabet[Math.floor(r() * alphabet.length)];
    if (n.trim() !== '' && !n.startsWith(' ')) names.add(`n${names.size}-${n}`);
  }
  for (const n of names) writeFileSync(join(repo, n), n);
  git(repo, ['add', '-A']);
  const raw = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  const exact = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean));
  assert.equal(exact.size, names.size);
  assert.ok(raw.some((l) => l.startsWith('"')), 'git must have quoted some names or the test proves nothing');
  for (const line of raw) assert.ok(exact.has(unquoteGitPath(line)), `decoded ${JSON.stringify(line)}`);
});

/** A glob subset on which ceasefire and Node's own matcher must agree (no dot-files, no trailing `**`). */
function randomPattern(r: () => number): string {
  const segs = ['a', 'b', 'c', 'ab', '*', '?', 'a*', '*b', '*a*', 'a?', '**', 'b?c'];
  const out: string[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) out.push(segs[Math.floor(r() * segs.length)] as string);
  if (out[out.length - 1] === '**') out.push('c');
  return out.join('/');
}

test('property: globMatch agrees with Node path.matchesGlob on a dot-free subset (differential, 4000 cases)', () => {
  const r = rng(11);
  const names = ['a', 'b', 'c', 'ab', 'bb', 'abc', 'bac', 'aa'];
  const matches = (pposix as unknown as { matchesGlob?: (p: string, g: string) => boolean }).matchesGlob;
  if (typeof matches !== 'function') return; // Node without the reference implementation
  let hits = 0;
  for (let k = 0; k < 4000; k++) {
    const pat = randomPattern(r);
    const path = Array.from({ length: 1 + Math.floor(r() * 4) }, () => names[Math.floor(r() * names.length)]).join('/');
    const mine = globMatch(pat, path);
    const ref: boolean = matches(path, pat);
    if (ref) hits++;
    assert.equal(mine, ref, `pattern ${JSON.stringify(pat)} path ${JSON.stringify(path)}`);
  }
  assert.ok(hits > 100, `the generator must produce matches (got ${hits})`);
});

test('property: every file name claims itself, overlap is symmetric, normalisation is idempotent', () => {
  const r = rng(23);
  const parts = ['a', 'B', 'c d', '[x]', '*', '?', 'f.ts', 'é', '..x', 'a\\b'];
  for (let k = 0; k < 1500; k++) {
    const name = Array.from({ length: 1 + Math.floor(r() * 4) }, () => parts[Math.floor(r() * parts.length)]).join('/');
    const literal = normalizePath(name.replace(/\\/g, '/'));
    assert.equal(normalizePath(literal), literal, `idempotent: ${name}`);
    assert.ok(fileMatchesClaim(literal, escapeGlob(literal)), `a name claims itself: ${literal}`);
    const other = Array.from({ length: 1 + Math.floor(r() * 3) }, () => parts[Math.floor(r() * parts.length)]).join('/');
    assert.equal(pathsOverlap(escapeGlob(literal), escapeGlob(other)), pathsOverlap(escapeGlob(other), escapeGlob(literal)), `symmetric: ${literal} ~ ${other}`);
  }
});

/* ------------------------------------------------------------------ */
/* golden files: output formats other tools and people read            */
/* ------------------------------------------------------------------ */

const GOLDEN = join(ROOT, 'test', 'golden');

function golden(name: string, actual: string): void {
  const file = join(GOLDEN, name);
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `golden file ${name} is missing (run with UPDATE_GOLDEN=1 once and review it)`);
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} changed: if intended, re-run with UPDATE_GOLDEN=1 and review the diff`);
}

const PRS = [
  { number: 12, title: 'Refactor login', headRef: 'feat/login', headSha: '1111111aaaa', baseRef: 'main', baseSha: '2222222bbbb', url: 'https://example.invalid/pr/12', author: 'agent-a', isDraft: false },
  { number: 13, title: 'Fix session bug', headRef: 'fix/session', headSha: '3333333cccc', baseRef: 'main', baseSha: '2222222bbbb', url: 'https://example.invalid/pr/13', author: 'agent-b', isDraft: true },
];

test('golden: PR comment for clear, advisory and blocked verdicts', () => {
  const input = { prs: PRS, repoFullName: 'example/repo', triggerSha: '1111111', runUrl: 'https://example.invalid/run/1' };
  const textual = [{ prA: '#12 feat/login', prB: '#13 fix/session', files: ['src/auth/session.ts', 'src/auth/login.ts'], severity: 'textual' as const }];
  const advisory = [{ prA: 'agent-a/feat/login (1f0c9a2e)', prB: 'agent-b/fix/session (8c1d77e0)', files: ['src/auth/'], severity: 'intent' as const, detail: 'refactor login', yields: 'agent-b' }];
  const lock = [{ prA: '#12 feat/login', prB: '#13 fix/session', files: ['package-lock.json'], severity: 'textual' as const, regenerable: true, hint: 'Run `npm install` after merging.' }];
  golden('comment-clear.md', renderCollisionComment({ ...input, collisions: [], verdict: deriveVerdict([]) }));
  golden('comment-advisory.md', renderCollisionComment({ ...input, collisions: advisory, verdict: deriveVerdict(advisory) }));
  golden('comment-blocked.md', renderCollisionComment({ ...input, collisions: [...textual, ...lock], verdict: deriveVerdict(textual) }));
});

test('golden: terminal messages for a blocked check and a clear check', () => {
  const report = {
    verdict: 'advisory' as const,
    files: ['src/auth/session.ts'],
    overridden: false,
    strict: false,
    contentions: [{ holder: 'builder', branch: 'feat/login', intentId: '1f0c9a2e-0000-4000-8000-000000000000', task: 'refactor login', expiresInMs: 3 * 3600_000 + 59 * 60_000, files: ['src/auth/session.ts'] }],
  };
  golden('check-advisory.txt', formatBlockedMessage(report) + '\n');
  golden('check-clear.txt', formatClearMessage(['a.ts', 'b.ts']) + '\n');
});

/** Replace the fields that change on every run so the shape and wording can be compared byte for byte. */
function stable(json: string, repo: string): string {
  return json
    .split(repo).join('<repo>')
    .replace(/"([0-9a-f]{8}-[0-9a-f-]{27})"/g, '"<uuid>"')
    .replace(/"(createdAt|expiresAt|lastSeen|at|generatedAt)": \d+/g, '"$1": 0')
    .replace(/intent [0-9a-f]{8} /g, 'intent <id8> ')
    .replace(/expires in [0-9dhm ]+\)/g, 'expires in <duration>)')
    .replace(/"expiresInMs": \d+/g, '"expiresInMs": 0')
    .replace(/"expiresInSec": \d+/g, '"expiresInSec": 0')
    .replace(/"(expires|expiresIn)": "[^"]*"/g, '"$1": "<duration>"');
}

test('golden: --json output of start, check, list, status and conflicts keeps its shape', { skip: WIN ? 'paths differ' : false }, () => {
  const repo = makeRepo();
  makeBranch(repo, 'one', { 'file.txt': 'line1\nONE\nline3\nline4\nline5\n' });
  makeBranch(repo, 'two', { 'file.txt': 'line1\nTWO\nline3\nline4\nline5\n' });
  const env = { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_JSON: '', CEASEFIRE_STRICT: '', CEASEFIRE_ALLOW_CONFLICT: '' };
  const run = (agent: string, args: string[]): string => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: agent }, encoding: 'utf8', input: '' });
    return `$ ceasefire ${args.join(' ')} --json   (exit ${r.status})\n${stable(r.stdout, repo)}${r.stderr ? 'stderr: ' + stable(r.stderr, repo) : ''}`;
  };
  const out = [
    run('builder', ['start', 'refactor', '--paths', 'file.txt']).replace(/--json /, ''),
    run('reviewer', ['check', 'file.txt']),
    run('reviewer', ['list']),
    run('reviewer', ['status']),
    run('reviewer', ['conflicts']),
  ].join('\n');
  golden('cli-json.txt', out);
});
