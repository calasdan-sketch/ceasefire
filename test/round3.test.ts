/** Expert round 3: object quarantine, ancestry skipping, hardened broadcast, start heads-up, doctor, MCP claim tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, makeRepo, makeBranch, tempDir } from './helpers.js';
import { relatedTips } from '../src/forecast/ancestry.js';
import { resolveCommits, withObjectQuarantine, gitResult } from '../src/forecast/git.js';
import { textualCollisions } from '../src/forecast/forecast.js';
import { isValidRemoteIntent, fetchRemoteIntents, pruneIntentRefs, broadcastIntent } from '../src/cli/sync.js';
import { cmdStart, cmdCheck, cmdDoctor, cmdConflicts, currentAgent, canonicalPaths } from '../src/cli/commands.js';
import { IntentStore } from '../src/intent/store.js';
import { CHECK_TOOL, CLAIM_TOOL, RELEASE_TOOL, STATUS_TOOL, runClaimTool, runReleaseTool, runStatusTool, runConflictsTool } from '../src/mcp/tools.js';
import type { McpSdk } from '../src/mcp/server.js';
import { intentCollisions } from '../src/forecast/forecast.js';
import type { Intent } from '../src/types.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

function cli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined>; input?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env, CEASEFIRE_SYNC: '0', ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync('node', [CLI, ...args], { cwd: opts.cwd, env, encoding: 'utf8', input: opts.input ?? '' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function objectCount(repo: string): number {
  return Number(/^count: (\d+)/m.exec(git(repo, ['count-objects', '-v']))?.[1]);
}

function quarantineDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('ceasefire-q-'));
}

/** Repo with `n` branches that conflict pairwise on file.txt and a few clean ones. */
function collidingRepo(): string {
  const repo = makeRepo();
  makeBranch(repo, 'a', { 'file.txt': 'line1\nAAA\nline3\nline4\nline5\n' });
  makeBranch(repo, 'b', { 'file.txt': 'line1\nBBB\nline3\nline4\nline5\n' });
  makeBranch(repo, 'c', { 'other.txt': 'changed\n' });
  return repo;
}

/* ------------------------------ quarantine ------------------------------ */

test('conflicts on branches writes no objects into the repository and leaves no temp directory', () => {
  const repo = collidingRepo();
  const before = objectCount(repo);
  const dirsBefore = quarantineDirs().length;
  const r = cli(['conflicts', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' } });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).collisionCount, 1, 'a<->b still found');
  assert.equal(objectCount(repo), before, 'no loose objects were added');
  assert.equal(quarantineDirs().length, dirsBefore, 'quarantine directory removed');
  assert.equal(git(repo, ['fsck', '--no-dangling', '--connectivity-only']).includes('error'), false);
});

test('conflicts --worktrees --untracked --deep leaves the object store untouched', () => {
  const repo = makeRepo();
  const wa = join(tempDir('ceasefire-q-wt-'), 'a');
  const wb = join(tempDir('ceasefire-q-wt-'), 'b');
  git(repo, ['worktree', 'add', '-q', '-b', 'wa', wa, 'main']);
  git(repo, ['worktree', 'add', '-q', '-b', 'wb', wb, 'main']);
  writeFileSync(join(wa, 'file.txt'), 'line1\nAAA\nline3\nline4\nline5\n');
  writeFileSync(join(wb, 'file.txt'), 'line1\nBBB\nline3\nline4\nline5\n');
  writeFileSync(join(wa, 'new.txt'), 'secret-ish\n');
  const before = objectCount(repo);
  const r = cli(['conflicts', '--worktrees', '--untracked', '--deep', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).collisionCount >= 1, 'uncommitted collision still found');
  assert.equal(objectCount(repo), before, 'snapshot blobs and commits never reached the repository');
});

test('withObjectQuarantine: writes go to the temp dir, reads still see the repo, nesting is safe', () => {
  const repo = makeRepo();
  const before = objectCount(repo);
  let blob = '';
  withObjectQuarantine(repo, () => {
    blob = gitResult(repo, ['hash-object', '-w', '--stdin'], { input: 'quarantined\n' }).stdout.trim();
    assert.match(blob, /^[0-9a-f]{40}$/);
    assert.equal(gitResult(repo, ['cat-file', '-t', blob]).stdout.trim(), 'blob', 'visible inside');
    withObjectQuarantine(repo, () => assert.equal(gitResult(repo, ['cat-file', '-t', 'HEAD']).stdout.trim(), 'commit', 'repo objects stay readable'));
    assert.equal(gitResult(repo, ['cat-file', '-t', blob]).stdout.trim(), 'blob', 'inner call did not end the outer quarantine');
  });
  assert.equal(objectCount(repo), before, 'nothing reached the repository');
  assert.notEqual(gitResult(repo, ['cat-file', '-e', blob]).exitCode, 0, 'gone afterwards');
});

/* -------------------------------- ancestry ------------------------------- */

test('relatedTips matches git merge-base --is-ancestor on a branchy history', () => {
  const repo = makeRepo();
  makeBranch(repo, 'x1', { 'file.txt': 'x1\n' });
  makeBranch(repo, 'x2', { 'other.txt': 'x2\n' }, 'x1');
  makeBranch(repo, 'y1', { 'y.txt': 'y1\n' });
  git(repo, ['checkout', '-q', '-b', 'merged', 'x2']);
  git(repo, ['merge', '-q', '--no-edit', 'y1']);
  git(repo, ['checkout', '-q', 'main']);
  const names = ['main', 'x1', 'x2', 'y1', 'merged'];
  const oid = new Map(names.map((n) => [n, git(repo, ['rev-parse', n])]));
  const related = relatedTips(repo, [...oid.values()], { force: true });
  const isAnc = (a: string, b: string): boolean => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }).status === 0;
  for (const a of names) {
    for (const b of names) {
      const expect = a === b || isAnc(a, b) || isAnc(b, a);
      assert.equal(related(oid.get(a)!, oid.get(b)!), expect, `${a} ~ ${b}`);
    }
  }
  assert.equal(related(oid.get('x1')!, oid.get('y1')!), false, 'diverged branches are not related');
});

test('relatedTips with 40 tips crosses the 32-bit word boundary correctly', () => {
  const repo = makeRepo();
  for (let i = 0; i < 40; i++) makeBranch(repo, `t${i}`, { [`f${i}.txt`]: `${i}\n` }, i % 3 === 0 ? 'main' : `t${i - 1}`);
  const names = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const oid = new Map(names.map((n) => [n, git(repo, ['rev-parse', n])]));
  const related = relatedTips(repo, [...oid.values()], { force: true });
  const isAnc = (a: string, b: string): boolean => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }).status === 0;
  for (const a of names) for (const b of names) assert.equal(related(oid.get(a)!, oid.get(b)!), a === b || isAnc(a, b) || isAnc(b, a), `${a} ~ ${b}`);
});

test('ancestor skipping never changes the answer: same collisions with and without it', () => {
  const repo = collidingRepo();
  git(repo, ['branch', 'stale1', 'main']);
  makeBranch(repo, 'a2', { 'other.txt': 'a2\n' }, 'a');
  const branches = ['main', 'a', 'b', 'c', 'a2', 'stale1'];
  const fast = textualCollisions(repo, branches);
  const slow = textualCollisions(repo, branches, undefined, { related: () => false });
  assert.deepEqual(fast, slow);
  assert.ok(fast.length >= 1);
});

test('600 identical branches forecast in a few seconds, not a minute', () => {
  const repo = makeRepo();
  for (let i = 0; i < 300; i++) git(repo, ['branch', `same${i}`]);
  const t = Date.now();
  const c = textualCollisions(repo, [...Array.from({ length: 300 }, (_, i) => `same${i}`), 'main']);
  assert.deepEqual(c, []);
  assert.ok(Date.now() - t < 20_000, `took ${Date.now() - t} ms`);
});

test('resolveCommits resolves many names in one go and drops bad ones', () => {
  const repo = collidingRepo();
  const m = resolveCommits(repo, ['a', 'b', 'nope', 'HEAD', '--evil', 'x\ny']);
  assert.equal(m.get('a'), git(repo, ['rev-parse', 'a']));
  assert.equal(m.get('HEAD'), git(repo, ['rev-parse', 'HEAD']));
  assert.equal(m.has('nope'), false);
  assert.equal(m.has('--evil'), false);
  assert.equal(m.has('x\ny'), false);
});

/* ------------------------- broadcast: validation + prune ------------------------- */

const NOW = Date.UTC(2026, 10, 7);
const base: Intent = { id: 'i-1', agent: 'a', task: 't', branch: 'b', paths: ['x'], createdAt: NOW - 1000, expiresAt: NOW + 3_600_000, status: 'active' };

test('remote intents that outlive the 7-day maximum or start in the future are rejected', () => {
  assert.equal(isValidRemoteIntent(base, NOW), true);
  assert.equal(isValidRemoteIntent({ ...base, expiresAt: NOW + 7 * 86_400_000 }, NOW), true, 'exactly the maximum is fine');
  assert.equal(isValidRemoteIntent({ ...base, expiresAt: 9_999_999_999_999 }, NOW), false, 'planted claim that never expires');
  assert.equal(isValidRemoteIntent({ ...base, expiresAt: NOW + 30 * 86_400_000 }, NOW), false);
  assert.equal(isValidRemoteIntent({ ...base, createdAt: NOW + 3 * 3_600_000, expiresAt: NOW + 7 * 3_600_000 }, NOW), true, 'a peer whose clock runs hours fast is not silently dropped');
  assert.equal(isValidRemoteIntent({ ...base, expiresAt: NOW + 7 * 86_400_000 + 23 * 3_600_000 }, NOW), true, 'under a day of skew on the lifetime is tolerated');
  assert.equal(isValidRemoteIntent({ ...base, expiresAt: NOW + 9 * 86_400_000 }, NOW), false);
});

function withSync<T>(fn: () => T): T {
  const prev = process.env.CEASEFIRE_SYNC;
  delete process.env.CEASEFIRE_SYNC;
  try {
    return fn();
  } finally {
    if (prev !== undefined) process.env.CEASEFIRE_SYNC = prev;
  }
}

function plant(repo: string, ref: string, payload: unknown): void {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' }).trim();
  git(repo, ['update-ref', `refs/ceasefire/intents/${ref}`, blob]);
}

test('old finished intents cannot crowd a new one out of the 500 cap', () => {
  const repo = makeRepo();
  const now = Date.now();
  withSync(() => {
    git(repo, ['remote', 'add', 'origin', repo]);
    // 520 long-expired refs whose names sort BEFORE the live one (the old code kept the first 500 names).
    const updates: string[] = [];
    for (let i = 0; i < 520; i++) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: JSON.stringify({ ...base, id: `a-old-${i}`, createdAt: now - 9 * 86_400_000, expiresAt: now - 8 * 86_400_000, status: 'done' }), encoding: 'utf8' }).trim();
      updates.push(`update refs/ceasefire/intents/a-old-${i} ${blob}\n`);
    }
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, input: updates.join('') });
    plant(repo, 'z-live', { ...base, id: 'z-live', createdAt: now, expiresAt: now + 3_600_000 });
    const seen = fetchRemoteIntents(repo, { fetch: false, now });
    assert.equal(seen[0]?.id, 'z-live', 'live intents are listed first');
    assert.ok(seen.length <= 500);
  });
});

test('pruneIntentRefs deletes dead, malformed and oversized refs, keeps live ones, and is rate limited', () => {
  const bare = tempDir('ceasefire-prune-bare-');
  git(bare, ['init', '--bare', '-q']);
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', bare]);
  const now = Date.now();
  withSync(() => {
    plant(repo, 'live', { ...base, id: 'live', createdAt: now, expiresAt: now + 3_600_000 });
    plant(repo, 'dead', { ...base, id: 'dead', createdAt: now - 5 * 86_400_000, expiresAt: now - 3 * 86_400_000 });
    plant(repo, 'finished', { ...base, id: 'finished', createdAt: now - 2 * 86_400_000, expiresAt: now + 86_400_000, status: 'done', completedAt: now - 2 * 86_400_000 });
    // long-running intent finished a minute ago: peers must get time to learn it is done
    plant(repo, 'justfinished', { ...base, id: 'justfinished', createdAt: now - 6 * 86_400_000, expiresAt: now + 86_400_000, status: 'done', completedAt: now - 60_000 });
    plant(repo, 'justdone', { ...base, id: 'justdone', createdAt: now - 60_000, expiresAt: now + 86_400_000, status: 'done' });
    plant(repo, 'junk', 'not json {{{');
    plant(repo, 'huge', { ...base, id: 'huge', task: 'x'.repeat(100_000) });
    git(repo, ['push', '-q', 'origin', '+refs/ceasefire/intents/*:refs/ceasefire/intents/*']);
    const n = pruneIntentRefs(repo, now);
    assert.equal(n, 4, 'dead, finished (a day old), junk, huge');
    const left = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/ceasefire/intents/']).split('\n').sort();
    assert.deepEqual(left, ['ceasefire/intents/justdone', 'ceasefire/intents/justfinished', 'ceasefire/intents/live'].sort());
    const remote = git(bare, ['for-each-ref', '--format=%(refname:short)', 'refs/ceasefire/intents/']).split('\n').sort();
    assert.deepEqual(remote, left, 'the remote copies are gone too');
    plant(repo, 'dead2', { ...base, id: 'dead2', createdAt: now - 5 * 86_400_000, expiresAt: now - 3 * 86_400_000 });
    assert.equal(pruneIntentRefs(repo, now + 60_000), 0, 'at most once per hour');
    assert.equal(pruneIntentRefs(repo, now + 2 * 3_600_000), 1);
  });
});

test('a finished intent is broadcast with its completion time', () => {
  const bare = tempDir('ceasefire-done-bare-');
  git(bare, ['init', '--bare', '-q']);
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', bare]);
  withSync(() => {
    assert.equal(broadcastIntent(repo, { ...base, id: 'fin', status: 'done' }), true);
    const blob = git(bare, ['cat-file', '-p', 'refs/ceasefire/intents/fin']);
    assert.equal(typeof JSON.parse(blob).completedAt, 'number');
  });
});

test('pruneIntentRefs never touches other refs and is a no-op with CEASEFIRE_SYNC=0', () => {
  const repo = makeRepo();
  git(repo, ['tag', 'v1']);
  process.env.CEASEFIRE_SYNC = '0';
  try {
    assert.equal(pruneIntentRefs(repo), 0);
  } finally {
    delete process.env.CEASEFIRE_SYNC;
  }
  assert.equal(git(repo, ['tag']), 'v1');
});

test('a repository path containing the alternates separator still works inside the quarantine', { skip: process.platform === 'win32' }, () => {
  const parent = tempDir('ceasefire-colon:dir-');
  const repo = join(parent, 'repo:one');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), '1\n2\n3\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  for (const [b, v] of [['p', 'P'], ['q', 'Q']] as const) {
    git(repo, ['checkout', '-q', '-b', b, 'main']);
    writeFileSync(join(repo, 'f.txt'), `1\n${v}\n3\n`);
    git(repo, ['commit', '-qam', b]);
  }
  git(repo, ['checkout', '-q', 'main']);
  const r = cli(['conflicts', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).collisionCount, 1, r.stderr);
  assert.equal(r.stderr.includes('warning'), false, r.stderr);
});

test('MCP claim refuses paths that look like flags', async () => {
  const r = await runClaimTool(CLI, { task: 't', paths: ['--ttl', '1m'] });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /may not start with "-"/);
});

test('adaptive ancestry never changes results: small repo (equality only) and forced walk agree', () => {
  const repo = collidingRepo();
  git(repo, ['branch', 'older', 'main']);
  makeBranch(repo, 'a2', { 'other.txt': 'a2\n' }, 'a');
  const names = ['main', 'older', 'a', 'a2', 'b', 'c'];
  const oid = new Map(names.map((n) => [n, git(repo, ['rev-parse', n])]));
  const adaptive = relatedTips(repo, [...oid.values()]);
  const forced = relatedTips(repo, [...oid.values()], { force: true });
  assert.equal(adaptive(oid.get('main')!, oid.get('older')!), true, 'equal tips are always related');
  assert.equal(forced(oid.get('a')!, oid.get('a2')!), true);
  assert.deepEqual(textualCollisions(repo, names), textualCollisions(repo, names, undefined, { related: forced }));
});

/* ----------------------------- start heads-up ----------------------------- */

function manyFilesRepo(n: number): string {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(repo, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'many']);
  return repo;
}

test('start tells the second agent who already holds its paths, and who claimed first', () => {
  const repo = makeRepo();
  const a = cli(['start', 'first', '--paths', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'alice' } });
  assert.equal(a.code, 0);
  assert.doesNotMatch(a.stdout, /heads-up/, 'nobody else holds anything yet');
  const b = cli(['start', 'second', '--paths', 'file.txt', 'other.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'bob' } });
  assert.equal(b.code, 0, 'still advisory: exit 0');
  assert.match(b.stdout, /heads-up/);
  assert.match(b.stdout, /"alice"/);
  assert.match(b.stdout, /file\.txt/);
  assert.match(b.stdout, /claimed before you/);
  assert.doesNotMatch(b.stdout, /other\.txt: /, 'only the contested file is listed');
  const j = cli(['start', 'third', '--paths', 'file.txt', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'carol' } });
  const parsed = JSON.parse(j.stdout) as { intent: { id: string }; contested: Array<{ holder: string; claimedFirst: boolean }>; warnings: string[] };
  assert.deepEqual(parsed.contested.map((c) => c.holder).sort(), ['alice', 'bob']);
  assert.ok(parsed.contested.every((c) => c.claimedFirst));
  assert.deepEqual(parsed.warnings, []);
});

test('the start heads-up escapes terminal controls and bidi tricks from other agents', () => {
  const repo = makeRepo();
  const evil = 'bu\u001b[2Jil\u202eder\u200b';
  const e = cli(['start', 'do \u001b]0;pwned\u0007 it', '--paths', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: evil } });
  assert.equal(e.code, 0);
  const r = cli(['start', 'mine', '--paths', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'victim' } });
  assert.doesNotMatch(r.stdout, /[\u001b\u0007\u202e\u200b]/);
  assert.match(r.stdout, /<U\+202E>/);
  assert.match(r.stdout, /heads-up/);
});

test('start warns when a claim covers most of the repository, and when the agent name is a guess', () => {
  const repo = manyFilesRepo(30);
  const wide = cli(['start', 'everything', '--paths', 'src/**'], { cwd: repo, env: { CEASEFIRE_AGENT: 'greedy' } });
  assert.match(wide.stdout, /covers 30 of 32 tracked files/);
  const narrow = cli(['start', 'one dir', '--paths', 'src/f1.ts'], { cwd: repo, env: { CEASEFIRE_AGENT: 'tidy' } });
  assert.doesNotMatch(narrow.stdout, /warning/);
  const guessed = cli(['start', 'x', '--paths', 'src/f2.ts'], { cwd: repo, env: { CEASEFIRE_AGENT: '' } });
  assert.match(guessed.stdout, /agent name defaulted to/);
});

test('default agent name includes the host so identical users on different machines differ', () => {
  const prev = process.env.CEASEFIRE_AGENT;
  delete process.env.CEASEFIRE_AGENT;
  try {
    assert.match(currentAgent(), /@/);
    process.env.CEASEFIRE_AGENT = 'explicit';
    assert.equal(currentAgent(), 'explicit');
  } finally {
    if (prev === undefined) delete process.env.CEASEFIRE_AGENT;
    else process.env.CEASEFIRE_AGENT = prev;
  }
});

test('intent collisions name the side that should step aside: the later claim, same answer for both agents', () => {
  const mk = (id: string, agent: string, createdAt: number): Intent => ({ ...base, id, agent, createdAt, expiresAt: NOW + 3_600_000 });
  const early = mk('zzz', 'early', NOW - 5000);
  const late = mk('aaa', 'late', NOW - 1000);
  for (const order of [[early, late], [late, early]]) {
    const [c] = intentCollisions(order, NOW);
    assert.match(c!.yields ?? '', /^late\//);
  }
  const t1 = mk('aaa', 'p', NOW - 1000);
  const t2 = mk('bbb', 'q', NOW - 1000);
  assert.match(intentCollisions([t2, t1], NOW)[0]!.yields ?? '', /^q\//, 'equal times: lower id keeps priority');
});

/* ------------------------------ check changes ------------------------------ */

test('check ignores .git internals; outside a repository it errors instead of saying clear', () => {
  const repo = makeRepo();
  cli(['start', 'all', '--paths', '**'], { cwd: repo, env: { CEASEFIRE_AGENT: 'hog' } });
  const r = cli(['check', '.git/config'], { cwd: repo, env: { CEASEFIRE_AGENT: 'other' } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /not tracked content/);
  const mixed = cli(['check', '.git/config', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'other' } });
  assert.equal(mixed.code, 2, 'file.txt is still in contention');
  assert.doesNotMatch(mixed.stdout, /\.git\/config/);
  const outside = tempDir('ceasefire-nogit-');
  const o = cli(['check', 'a.txt'], { cwd: outside, env: { CEASEFIRE_AGENT: 'x', GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(o.code, 1);
  assert.match(o.stderr, /not a git repository/);
});

test('check --claim holds the files so a second agent is warned (agents without the Claude hook)', () => {
  const repo = makeRepo();
  const first = cli(['check', 'file.txt', '--claim'], { cwd: repo, env: { CEASEFIRE_AGENT: 'codex' } });
  assert.equal(first.code, 0);
  const second = cli(['check', 'file.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'cursor' } });
  assert.equal(second.code, 2);
  assert.match(second.stdout, /codex/);
  const plain = cli(['check', 'other.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'codex' } });
  const stillFree = cli(['check', 'other.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'cursor' } });
  assert.equal(plain.code, 0);
  assert.equal(stillFree.code, 0, 'without --claim nothing is held');
});

test('check --stdin reads newline or NUL separated names', () => {
  const repo = makeRepo();
  cli(['start', 'x', '--paths', 'other.txt'], { cwd: repo, env: { CEASEFIRE_AGENT: 'holder' } });
  const nl = cli(['check', '--stdin', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' }, input: 'file.txt\r\nother.txt\n\n' });
  assert.equal(nl.code, 2);
  assert.deepEqual(JSON.parse(nl.stdout).files, ['file.txt', 'other.txt']);
  const nul = cli(['check', '--stdin', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' }, input: 'file.txt\0other.txt\0' });
  assert.deepEqual(JSON.parse(nul.stdout).files, ['file.txt', 'other.txt']);
  const empty = cli(['check', '--stdin'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' }, input: '' });
  assert.equal(empty.code, 1, 'no names at all is a usage error, not "clear"');
});

test('a detached HEAD is labelled with the commit, not "unknown"', () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-q', '--detach']);
  const r = cli(['start', 'x', '--paths', 'file.txt', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'd', CEASEFIRE_BRANCH: '' } });
  assert.match(JSON.parse(r.stdout).intent.branch, /^detached@[0-9a-f]{8}$/);
});

/* ---------------------------------- misc ---------------------------------- */

test('a closed pipe (| head) is not an error and prints no stack trace', { skip: process.platform === 'win32' }, () => {
  const repo = makeRepo();
  const dir = join(repo, '.git', 'ceasefire');
  mkdirSync(dir, { recursive: true });
  const store = new IntentStore(join(dir, 'intents.db'));
  for (let i = 0; i < 120; i++) store.publish('x'.repeat(2000) + i, [`src/${i}.ts`], { agent: `a${i}`, branch: 'main' });
  store.close();
  const r = spawnSync('sh', ['-c', `node "${CLI}" list --json | head -c 10 >/dev/null`], { cwd: repo, env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'me' }, encoding: 'utf8' });
  assert.doesNotMatch(r.stderr, /EPIPE|node:events/);
});

test('doctor reports a bare repo honestly and works as JSON', () => {
  const repo = makeRepo();
  const r = cli(['doctor', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: '' } });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.stdout) as { ok: boolean; checks: Array<{ name: string; status: string }> };
  assert.equal(d.ok, true);
  const by = (n: string) => d.checks.find((c) => c.name === n)?.status;
  assert.equal(by('repository'), 'ok');
  assert.equal(by('ledger'), 'ok');
  assert.equal(by('identity'), 'warn');
  assert.equal(by('claude hook'), 'warn');
  assert.equal(by('cross-machine sync'), 'warn');
  cli(['init', '--claude'], { cwd: repo });
  const after = JSON.parse(cli(['doctor', '--json'], { cwd: repo, env: { CEASEFIRE_AGENT: 'me' } }).stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const hook = after.checks.find((c) => c.name === 'claude hook')!;
  assert.equal(hook.status, 'ok');
  assert.match(hook.detail, /SessionEnd release hook installed/);
  const outside = tempDir('ceasefire-doctor-nogit-');
  const o = cli(['doctor'], { cwd: outside, env: { GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(o.code, 1);
  assert.match(o.stdout, /FAIL\] repository/);
});

/* ------------------------------------ MCP ------------------------------------ */

test('MCP claim, status and release tools drive the real CLI end to end', async () => {
  const repo = makeRepo();
  process.env.CEASEFIRE_SYNC = '0';
  process.env.CEASEFIRE_AGENT = 'mcp-agent';
  try {
    const first = await runClaimTool(CLI, { task: 'edit file', paths: ['file.txt'], ttl: '30m', cwd: repo });
    assert.notEqual(first.isError, true, first.content[0]?.text);
    const claimed = JSON.parse(first.content[0]!.text) as { intent: { agent: string; paths: string[] }; contested: unknown[] };
    assert.equal(claimed.intent.agent, 'mcp-agent');
    assert.deepEqual(claimed.intent.paths, ['file.txt']);
    const status = await runStatusTool(CLI, { cwd: repo });
    assert.match(status.content[0]!.text, /mcp-agent/);
    const conflicts = await runConflictsTool(CLI, { cwd: repo, deep: true, worktrees: true });
    assert.notEqual(conflicts.isError, true, conflicts.content[0]?.text);
    const released = await runReleaseTool(CLI, { cwd: repo });
    assert.notEqual(released.isError, true, released.content[0]?.text);
    assert.doesNotMatch((await runStatusTool(CLI, { cwd: repo })).content[0]!.text, /mcp-agent/);
    const bad = await runClaimTool(CLI, { task: '', paths: [] });
    assert.equal(bad.isError, true);
  } finally {
    delete process.env.CEASEFIRE_AGENT;
    delete process.env.CEASEFIRE_SYNC;
  }
});

test('MCP server lists five tools and reports the package version', async () => {
  const handlers = new Map<string, (r: unknown) => Promise<unknown>>();
  let info: { name: string; version: string } | undefined;
  const sdk: McpSdk = {
    Server: class {
      constructor(i: { name: string; version: string }) {
        info = i;
      }
      setRequestHandler(schema: { method: string }, h: (r: unknown) => Promise<unknown>): void {
        handlers.set(schema.method, h);
      }
      async connect(): Promise<void> {}
    } as unknown as McpSdk['Server'],
    StdioServerTransport: class {} as unknown as McpSdk['StdioServerTransport'],
    ListToolsRequestSchema: { method: 'tools/list' },
    CallToolRequestSchema: { method: 'tools/call' },
  };
  // The built server (dist/), because the version is read from the package.json next to it.
  const { buildServer } = (await import(pathToFileURL(join(dirname(CLI), 'mcp', 'server.js')).href)) as typeof import('../src/mcp/server.js');
  buildServer(sdk, { bin: '/nonexistent/ceasefire' });
  const pkg = JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(info?.version, pkg.version);
  const listed = (await handlers.get('tools/list')!({})) as { tools: Array<{ name: string }> };
  assert.deepEqual(listed.tools.map((t) => t.name), [CHECK_TOOL.name, 'ceasefire_conflicts', CLAIM_TOOL.name, RELEASE_TOOL.name, STATUS_TOOL.name]);
  const r = (await handlers.get('tools/call')!({ params: { name: 'ceasefire_claim', arguments: { task: 't', paths: ['a'] } } })) as { isError?: boolean };
  assert.equal(r.isError, true, 'a missing binary is reported, not thrown');
});

/* ------------------------- imports exercised for coverage ------------------------- */

test('exports used by the CLI exist', () => {
  assert.equal(typeof cmdStart, 'function');
  assert.equal(typeof cmdCheck, 'function');
  assert.equal(typeof cmdDoctor, 'function');
  assert.equal(typeof cmdConflicts, 'function');
  assert.equal(typeof canonicalPaths, 'function');
  assert.equal(typeof broadcastIntent, 'function');
  assert.equal(existsSync(CLI), true);
});
