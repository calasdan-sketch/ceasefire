/** Expert round 4: what a stranger gets from `npm i`: packaging, init in worktrees, unusable ledger, Node gate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, makeRepo, makeBranch, tempDir } from './helpers.js';
import { minorLine, nodeIsSupported } from '../src/version.js';
import { IntentStoreBusyError } from '../src/intent/index.js';
import { unquoteGitPath } from '../src/cli/gitquote.js';
import { notRepoMessage } from '../src/cli/commands.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');

function cli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }) {
  const env: NodeJS.ProcessEnv = { ...process.env, CEASEFIRE_SYNC: '0', ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('node', [CLI, ...args], { cwd: opts.cwd, env, encoding: 'utf8', input: '' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test('package: the tarball ships LICENSE, README, dist and no source maps, typings or tests', { skip: process.platform === 'win32' ? 'runs npm without a shell; not exercised on Windows' : false }, () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  for (const must of ['LICENSE', 'README.md', 'package.json', 'dist/cli.js', 'dist/cli/main.js', 'dist/version.js']) assert.ok(files.includes(must), `${must} is packed`);
  assert.deepEqual(files.filter((f) => /\.map$|\.d\.ts$|^test\/|^src\/|^bench\/|dist-test|\.test-tmp|\.env/.test(f)), []);
});

test('package: metadata is complete and consistent', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, any>;
  assert.equal(pkg.name, 'ceasefire');
  assert.equal(pkg.license, 'MIT');
  assert.ok(readFileSync(join(ROOT, 'LICENSE'), 'utf8').startsWith('MIT License'));
  assert.match(pkg.repository.url, /calasdan-sketch\/ceasefire/);
  assert.ok(pkg.author && pkg.homepage && pkg.bugs.url && pkg.keywords.length >= 5);
  assert.equal(pkg.bin.ceasefire, './dist/cli.js');
  assert.deepEqual(pkg.exports, { './package.json': './package.json' }, 'CLI only: no accidental deep-import API');
  assert.match(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.includes(`## ${pkg.version}`), 'CHANGELOG has a heading for the package version');
});

test('version helpers: minor line and Node gate', () => {
  assert.equal(minorLine('0.3.0'), '0.3');
  assert.equal(minorLine('1.12.4-rc.1'), '1.12');
  assert.equal(minorLine('weird'), 'latest');
  assert.equal(nodeIsSupported('22.13.0'), true);
  assert.equal(nodeIsSupported('22.12.9'), false);
  assert.equal(nodeIsSupported('20.18.0'), false);
  assert.equal(nodeIsSupported('24.0.1'), true);
  assert.equal(nodeIsSupported('garbage'), false);
  assert.equal(cliVersion(), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
});

function cliVersion(): string {
  return cli(['--version'], { cwd: ROOT }).stdout.trim().replace(/^ceasefire /, '');
}

test('init from a linked worktree installs the pre-push hook where git reads it', () => {
  const repo = makeRepo();
  const wt = join(tempDir('ceasefire-wt-'), 'second tree');
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'second']);
  const r = cli(['init'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  const real = join(git(repo, ['rev-parse', '--absolute-git-dir']), 'hooks', 'pre-push');
  assert.ok(existsSync(real), 'hook is in the shared hooks folder');
  assert.match(readFileSync(real, 'utf8'), /ceasefire/);
  const own = join(git(wt, ['rev-parse', '--absolute-git-dir']), 'hooks', 'pre-push');
  assert.equal(existsSync(own), false, 'nothing written where git never looks');
});

test('init leaves .gitignore alone and does not claim to have changed it', () => {
  const repo = makeRepo();
  const r = cli(['init'], { cwd: repo });
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(repo, '.gitignore')), false);
  assert.doesNotMatch(r.stdout, /gitignore/);
  assert.equal(git(repo, ['status', '--porcelain']).includes('.gitignore'), false);
});

test('init respects core.hooksPath: it does not write into a hook manager folder', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.husky'));
  git(repo, ['config', 'core.hooksPath', '.husky']);
  const r = cli(['init'], { cwd: repo });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pre-push hook NOT installed/);
  assert.equal(existsSync(join(repo, '.husky', 'pre-push')), false);
  assert.equal(existsSync(join(repo, '.git', 'hooks', 'pre-push')), false);
});

test('init workflow stub pins the minor line instead of @latest', () => {
  const repo = makeRepo();
  cli(['init'], { cwd: repo });
  const wf = readFileSync(join(repo, '.github', 'workflows', 'ceasefire.yml'), 'utf8');
  assert.doesNotMatch(wf, /@latest/);
  assert.match(wf, /npx --yes ceasefire@\d+\.\d+ conflicts --json/);
});

test('an unusable ledger: conflicts still forecasts branches (with a warning); check fails in plain words', () => {
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'line1\nAAA\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nBBB\nline3\nline4\nline5\n' });
  const notADir = join(tempDir('ceasefire-bad-'), 'file');
  writeFileSync(notADir, 'x');
  const env = { CEASEFIRE_DIR: join(notADir, 'sub'), CEASEFIRE_AGENT: 'me' };
  const c = cli(['conflicts', '--json'], { cwd: repo, env });
  assert.equal(c.code, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).collisionCount, 1);
  assert.match(c.stderr, /warning: .*cannot use the intent store/);
  const k = cli(['check', 'file.txt'], { cwd: repo, env });
  assert.equal(k.code, 1);
  assert.match(k.stderr, /cannot use the intent store/);
  assert.match(k.stderr, /CEASEFIRE_DIR/);
  assert.doesNotMatch(k.stderr, /long lock/);
});

test('store errors: a lock says busy, a permission problem says so', () => {
  const lock = Object.assign(new Error('database is locked'), { errcode: 5 });
  assert.match(new IntentStoreBusyError('/x/db', lock).message, /busy/);
  const perm = Object.assign(new Error('attempt to write a readonly database'), { errcode: 8 });
  const m = new IntentStoreBusyError('/x/db', perm).message;
  assert.match(m, /read-only|permissions/);
  assert.doesNotMatch(m, /long lock/);
});

test('outside a repository the message says so', () => {
  const dir = tempDir('ceasefire-norepo-');
  assert.match(notRepoMessage(dir, 'More.'), /^not a git repository\. More\./);
  const r = cli(['conflicts'], { cwd: dir, env: { GIT_CEILING_DIRECTORIES: dirname(dir) } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);
});

test('help lists all five MCP tools', () => {
  const r = cli(['--help'], { cwd: ROOT });
  assert.match(r.stdout, /ceasefire_claim/);
  assert.match(r.stdout, /ceasefire_status/);
});

test('start says when the claim could not be shared or is too big to share', () => {
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', 'https://127.0.0.1:9/none.git']);
  const env = { CEASEFIRE_SYNC: '1', CEASEFIRE_FETCH_TIMEOUT_MS: '1000', CEASEFIRE_AGENT: 'me' };
  const a = cli(['start', 'small', '--paths', 'file.txt'], { cwd: repo, env });
  assert.equal(a.code, 0);
  assert.match(a.stdout, /could not reach "origin"/);
  const big = cli(['start', 'x'.repeat(20_000), '--paths', 'file.txt'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'me2' } });
  assert.equal(big.code, 0);
  assert.match(big.stdout, /too large to share/);
  const local = cli(['start', 'quiet', '--paths', 'other.txt'], { cwd: repo, env: { ...env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'me3' } });
  assert.doesNotMatch(local.stdout, /could not reach|too large/, 'sync switched off: no warning');
});

test('git-quoted names from `git diff --name-only` are decoded for check --stdin', () => {
  assert.equal(unquoteGitPath('"src/caf\\303\\251.ts"'), 'src/café.ts');
  assert.equal(unquoteGitPath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.equal(unquoteGitPath('plain.ts'), 'plain.ts');
  assert.equal(unquoteGitPath('"bad\\q"'), '"bad\\q"', 'not git quoting: unchanged');
  const repo = makeRepo();
  writeFileSync(join(repo, 'café.txt'), 'x\n');
  git(repo, ['add', 'café.txt']);
  const env = { CEASEFIRE_AGENT: 'a' };
  cli(['start', 'mine', '--paths', 'café.txt'], { cwd: repo, env });
  const names = git(repo, ['diff', '--cached', '--name-only']);
  assert.match(names, /^"caf\\303\\251\.txt"$/, 'git really quotes it');
  const r = spawnSync('node', [CLI, 'check', '--stdin'], { cwd: repo, env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'b' }, input: names + '\n', encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /café\.txt/);
});

test('check --stdin with an empty pipe fails closed and says why', () => {
  const repo = makeRepo();
  const r = cli(['check', '--stdin'], { cwd: repo, env: { CEASEFIRE_AGENT: 'a' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /received no file names/);
  assert.doesNotMatch(r.stderr, /usage:/);
});
