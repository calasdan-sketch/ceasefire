/**
 * Regression tests for the synapse-1 panel review (findings 1-9).
 * Each block names the finding it pins down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { git, makeRepo, tempDir } from './helpers.js';
import { IntentStore, openIntentStore, IntentStoreBusyError, isCorruptionError } from '../src/intent/index.js';
import { installClaudeHook, CLAUDE_HOOK_COMMAND, repoIgnoresCase } from '../src/cli/commands.js';
import { canonicalizePath, fileMatchesClaim, globMatch, pathsOverlap, PathOutsideRepoError } from '../src/forecast/paths.js';
import { enableFetchCaching, fetchRemoteIntents, parseBatch } from '../src/cli/sync.js';
import { forecastWorktrees } from '../src/forecast/worktrees.js';
import type { Intent } from '../src/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');

function run(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string }) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'test-agent', ...opts.env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: opts.input ?? '',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/* ---------------- 1. SQLITE_BUSY must never wipe the store ---------------- */

test('F1: a long-held write lock makes open fail with BusyError and quarantines nothing', () => {
  const dir = tempDir('ceasefire-busy-');
  const dbPath = join(dir, 'intents.db');
  const s = new IntentStore(dbPath);
  s.publish('keep me', ['k.ts'], { agent: 'a', branch: 'main' });
  s.close();
  const holder = new DatabaseSync(dbPath);
  holder.exec('PRAGMA busy_timeout = 0');
  holder.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => openIntentStore(dbPath, { busyTimeoutMs: 50 }), IntentStoreBusyError);
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('corrupt')), [], 'nothing quarantined');
  } finally {
    holder.exec('COMMIT');
    holder.close();
  }
  const again = openIntentStore(dbPath);
  assert.equal(again.list({ status: 'active' }).length, 1, 'intent survived the contention');
  again.close();
});

test('F1: a corrupt DB next to a recently written WAL is not moved', () => {
  const dir = tempDir('ceasefire-livewal-');
  const dbPath = join(dir, 'intents.db');
  writeFileSync(dbPath, 'x'.repeat(4096));
  writeFileSync(`${dbPath}-wal`, 'live');
  assert.throws(() => openIntentStore(dbPath), /refusing to move a live WAL/);
  assert.ok(existsSync(`${dbPath}-wal`));
  assert.ok(existsSync(dbPath));
});

test('F1: only SQLITE_CORRUPT / SQLITE_NOTADB count as corruption', () => {
  assert.equal(isCorruptionError({ errcode: 5 }), false, 'SQLITE_BUSY');
  assert.equal(isCorruptionError({ errcode: 517 }), false, 'SQLITE_BUSY_SNAPSHOT');
  assert.equal(isCorruptionError({ errcode: 6 }), false, 'SQLITE_LOCKED');
  assert.equal(isCorruptionError({ errcode: 26 }), true, 'SQLITE_NOTADB');
  assert.equal(isCorruptionError({ errcode: 267 }), true, 'SQLITE_CORRUPT_VTAB');
  assert.equal(isCorruptionError(new Error('x')), false);
});

/* ---------------- 2. strict mode must not fail open ---------------- */

function strictSetup() {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-f2-store-') };
  assert.equal(run(['start', 'auth', '--paths', 'src/auth/'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'other' } }).code, 0);
  return { repo, env };
}

test('F2: the repo is found from file_path even when the session cwd is outside it', () => {
  const { repo, env } = strictSetup();
  for (const cwd of ['/', dirname(repo)]) {
    const input = JSON.stringify({ cwd, tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'auth', 'new', 'x.ts') } });
    const r = run(['hook', 'claude', '--strict'], { cwd: '/', env, input });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', `cwd=${cwd}`);
  }
});

test('F2: case-insensitive repos fold case (core.ignorecase=true)', () => {
  const { repo, env } = strictSetup();
  git(repo, ['config', 'core.ignorecase', 'true']);
  assert.equal(repoIgnoresCase(repo), true);
  assert.equal(run(['check', 'SRC/Auth/Login.ts'], { cwd: repo, env }).code, 2);
  assert.equal(
    canonicalizePath(join(repo.toUpperCase(), 'src', 'a.ts'), repo, repo, { ignoreCase: true }).toLowerCase(),
    'src/a.ts',
    'an upper-cased absolute path is inside the repo on a case-insensitive volume',
  );
  const sensitive = makeRepo();
  git(sensitive, ['config', 'core.ignorecase', 'false']);
  assert.equal(repoIgnoresCase(sensitive), false);
});

test('F2: init --claude --strict writes onFailure "block" and the --strict hook', () => {
  const repo = makeRepo();
  installClaudeHook(repo, { strict: true });
  const h = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0];
  assert.equal(h.onFailure, 'block');
  assert.equal(h.command, `${CLAUDE_HOOK_COMMAND} --strict`);
  const loose = makeRepo();
  installClaudeHook(loose);
  const l = JSON.parse(readFileSync(join(loose, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0];
  assert.equal(l.onFailure, undefined, 'advisory hook never blocks, by design');
});

/* ---------------- 3 + 4. bounded, cached, batched fetch; --worktrees stays offline ---------------- */

function intent(id: string): Intent {
  const now = Date.now();
  return { id, agent: 'remote', task: 't', branch: 'b', paths: ['p.ts'], createdAt: now, expiresAt: now + 3_600_000, status: 'active' };
}

function plant(repoOrBare: string, i: Intent): void {
  const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repoOrBare, input: JSON.stringify(i), encoding: 'utf8' });
  git(repoOrBare, ['update-ref', `refs/ceasefire/intents/${i.id}`, r.stdout.trim()]);
}

function withOrigin() {
  const bare = tempDir('ceasefire-origin-');
  git(bare, ['init', '-q', '--bare']);
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', bare]);
  return { bare, repo };
}

function withSyncEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['CEASEFIRE_SYNC', ...Object.keys(env)]) saved[k] = process.env[k];
  delete process.env['CEASEFIRE_SYNC'];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('F3: all intent blobs are read in one batch, oversized ones skipped', () => {
  const { bare, repo } = withOrigin();
  for (let n = 0; n < 40; n++) plant(bare, intent(`id-${n}`));
  const big = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: bare, input: 'x'.repeat(70 * 1024), encoding: 'utf8' });
  git(bare, ['update-ref', 'refs/ceasefire/intents/big', big.stdout.trim()]);
  const got = withSyncEnv({}, () => fetchRemoteIntents(repo));
  assert.equal(got.length, 40);
  assert.deepEqual(parseBatch('abc missing\n'), []);
  assert.deepEqual(parseBatch(`${'a'.repeat(40)} blob ${Buffer.byteLength('hé')}\nhé\n`), ['hé'], 'sizes are bytes');
});

test('F3: with hook caching, a second fetch inside the TTL is skipped; TTL=0 always fetches', () => {
  const { bare, repo } = withOrigin();
  plant(bare, intent('first'));
  enableFetchCaching(true);
  try {
    assert.equal(withSyncEnv({ CEASEFIRE_FETCH_TTL_S: '600' }, () => fetchRemoteIntents(repo)).length, 1);
    plant(bare, intent('second'));
    assert.equal(withSyncEnv({ CEASEFIRE_FETCH_TTL_S: '600' }, () => fetchRemoteIntents(repo)).length, 1, 'cached');
    assert.equal(withSyncEnv({ CEASEFIRE_FETCH_TTL_S: '0' }, () => fetchRemoteIntents(repo)).length, 2, 'TTL 0 refetches');
  } finally {
    enableFetchCaching(false);
  }
  plant(bare, intent('third'));
  assert.equal(withSyncEnv({}, () => fetchRemoteIntents(repo)).length, 3, 'explicit commands always fetch');
});

test('F3: a hanging remote is cut off by the fetch timeout', () => {
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', 'ssh://ceasefire.invalid/repo.git']);
  // git appends host + command to core.sshCommand; `sh -c 'sleep 30' x` ignores them and hangs.
  git(repo, ['config', 'core.sshCommand', "sh -c 'sleep 30' ceasefire-ssh"]);
  const t0 = Date.now();
  const got = withSyncEnv({ CEASEFIRE_FETCH_TIMEOUT_MS: '700' }, () => fetchRemoteIntents(repo));
  assert.deepEqual(got, []);
  const took = Date.now() - t0;
  assert.ok(took >= 600, `the fake remote really hung (took ${took}ms)`);
  assert.ok(took < 10_000, `took ${took}ms`);
});

test('F4: conflicts --worktrees does not fetch: no ref and no FETCH_HEAD written', () => {
  const { bare, repo } = withOrigin();
  plant(bare, intent('remote-1'));
  const r = run(['conflicts', '--worktrees', '--json'], { cwd: repo, env: { CEASEFIRE_SYNC: '1', CEASEFIRE_DIR: tempDir('ceasefire-f4-') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(repo, ['for-each-ref', 'refs/ceasefire/']), '', 'no intent refs created');
  assert.equal(existsSync(join(repo, '.git', 'FETCH_HEAD')), false);
});

/* ---------------- 5. brackets in file names ---------------- */

test('F5: checked files are literals; bracketed route names do not cross-match', () => {
  assert.equal(pathsOverlap('app/[id]/page.tsx', 'app/[slug]/layout.tsx'), false);
  assert.equal(pathsOverlap('[locale]/a.tsx', 'docs/*.md'), false);
  assert.equal(fileMatchesClaim('app/[id]/page.tsx', 'app/[id]/page.tsx'), true, 'exact text still covers the file');
  assert.equal(fileMatchesClaim('app/\\[id\\]/page.tsx', 'docs/*.md'), false);
  assert.equal(fileMatchesClaim('app/[id]/page.tsx', 'app/\\[id\\]/page.tsx'), true, 'escaped claim is literal');
  assert.equal(fileMatchesClaim('app/i/page.tsx', 'app/\\[id\\]/page.tsx'), false);
  assert.equal(globMatch('app/\\[id\\]/*.tsx', 'app/[id]/page.tsx'), true);
});

test('F5: start escapes claims that name an existing bracketed file', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'app', '[id]'), { recursive: true });
  writeFileSync(join(repo, 'app', '[id]', 'page.tsx'), 'x');
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-f5-') };
  run(['start', 'route', '--paths', 'app/[id]/page.tsx'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'other' } });
  const listed = JSON.parse(run(['list', '--json'], { cwd: repo, env }).stdout);
  assert.deepEqual(listed.intents[0].paths, ['app/\\[id\\]/page.tsx']);
  assert.equal(run(['check', 'app/[id]/page.tsx'], { cwd: repo, env }).code, 2);
  assert.equal(run(['check', 'app/i/page.tsx'], { cwd: repo, env }).code, 0);
});

/* ---------------- 6. canonicalization bypasses ---------------- */

test('F6: Windows roots — case, POSIX paths, separator check, drive-relative, \\\\?\\', () => {
  const root = 'C:/Repo';
  const cwd = 'C:\\Repo';
  const upper = canonicalizePath('C:\\Repo\\SRC\\a.ts', cwd, root);
  assert.equal(pathsOverlap(upper, 'src/a.ts', { ignoreCase: true }), true, 'Windows case folds');
  assert.equal(repoIgnoresCase(root), true);
  assert.throws(() => canonicalizePath('/etc/passwd', cwd, root), PathOutsideRepoError);
  assert.equal(canonicalizePath('/c/Repo/src/a.ts', cwd, root), 'src/a.ts', 'MSYS path maps to the drive');
  assert.throws(() => canonicalizePath('/d/Repo/src/a.ts', cwd, root), PathOutsideRepoError);
  assert.equal(canonicalizePath('x.ts', 'C:/repo2/sub', root), 'x.ts', 'C:/repo2 is not inside C:/repo');
  assert.throws(() => canonicalizePath('C:/repo2/x.ts', cwd, root), PathOutsideRepoError);
  assert.throws(() => canonicalizePath('C:src\\a.ts', cwd, root), /drive-relative/);
  assert.equal(canonicalizePath('\\\\?\\C:\\Repo\\src\\a.ts', cwd, root), 'src/a.ts');
  assert.equal(canonicalizePath('\\\\?\\UNC\\srv\\share\\r\\a.ts', '//srv/share/r', '//srv/share/r'), 'a.ts');
});

/* ---------------- 7. glob matcher complexity ---------------- */

test('F7: unterminated brackets and stars stay fast at the size cap', () => {
  const t0 = Date.now();
  assert.equal(globMatch('*' + '['.repeat(1998), '['.repeat(1998) + 'x'), false);
  assert.equal(globMatch('*' + '['.repeat(4000), '['.repeat(4000) + 'x'), false);
  assert.equal(globMatch('*[' + '*['.repeat(1500), '['.repeat(4000)), true);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

/* ---------------- 8. inherited redirecting git env ---------------- */

test('F8: inherited GIT_INDEX_FILE / GIT_DIR do not leak into snapshots', () => {
  const repo = makeRepo();
  const wa = join(tempDir('ceasefire-f8-'), 'a');
  const wb = join(tempDir('ceasefire-f8-'), 'b');
  git(repo, ['worktree', 'add', '-q', '-b', 'a', wa, 'main']);
  git(repo, ['worktree', 'add', '-q', '-b', 'b', wb, 'main']);
  writeFileSync(join(wa, 'file.txt'), 'A\n');
  writeFileSync(join(wb, 'file.txt'), 'B\n');
  const decoy = makeRepo();
  const saved = { i: process.env['GIT_INDEX_FILE'], d: process.env['GIT_DIR'] };
  process.env['GIT_INDEX_FILE'] = join(tempDir('ceasefire-f8-idx-'), 'bogus-index');
  process.env['GIT_DIR'] = join(decoy, '.git');
  try {
    const f = forecastWorktrees(repo);
    assert.equal(f.worktrees.length, 3);
    assert.equal(f.collisions.length, 1);
  } finally {
    if (saved.i === undefined) delete process.env['GIT_INDEX_FILE'];
    else process.env['GIT_INDEX_FILE'] = saved.i;
    if (saved.d === undefined) delete process.env['GIT_DIR'];
    else process.env['GIT_DIR'] = saved.d;
  }
});

/* ---------------- 9. docs accuracy ---------------- */

test('F9: docs state the real snapshot, gc, dependency and history facts', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /gc\.pruneExpire/);
  assert.match(readme, /modified tracked files/i);
  assert.match(readme, /LFS/);
  assert.match(readme, /no size cap/i);
  assert.match(readme, /transitive/i);
  assert.doesNotMatch(readme, /linear-time/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'intent', 'store.ts'), 'utf8'), /Zero runtime dependencies/);
  assert.match(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), /titled "v1\.0\.0"/);
});
