/** Scrutiny + hardening regression tests (v1 panel review, 2026-10-18).
 *
 * Each test pins a finding from the security / git-internals / systems
 * review: the merge-tree engine rewrite (binary + rename detection, no
 * marker-parsing false positives), SQLite concurrency + corruption
 * recovery, output sanitization, override telemetry, sync validation,
 * and the GitHub Action hardening.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { git, makeRepo, makeBranch, tempDir, FIVE } from './helpers.js';
import {
  mergeTreeConflictedFiles,
  mergeTreeConflictedFilesLegacy,
  textualCollisions,
  mergeBase,
} from '../src/forecast/forecast.js';
import { listLocalBranches } from '../src/forecast/git.js';
import { IntentStore, openIntentStore } from '../src/intent/index.js';
import { sanitizeDisplay } from '../src/cli/format.js';
import type { Intent } from '../src/types.js';

/* ------------------------------------------------------------------ */
/* CLI runner (mirrors test/cli.test.ts)                               */
/* ------------------------------------------------------------------ */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CEASEFIRE_DIR: tempDir('ceasefire-hardening-store-'),
    CEASEFIRE_AGENT: 'test-agent',
    CEASEFIRE_SYNC: '0',
    ...opts.env,
  };
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: opts.cwd ?? tempDir('ceasefire-hardening-cwd-'),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

/** Branch helper accepting binary content. */
function makeBranchRaw(
  repo: string,
  name: string,
  edits: Record<string, string | Buffer>,
  from = 'main',
): void {
  git(repo, ['checkout', '-qb', name, from]);
  for (const [p, content] of Object.entries(edits)) {
    writeFileSync(join(repo, p), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', name]);
  git(repo, ['checkout', '-q', 'main']);
}

/* ------------------------------------------------------------------ */
/* H1: binary file conflicts were silently missed                       */
/* ------------------------------------------------------------------ */

test('H1: binary add/add conflict is detected', () => {
  const repo = makeRepo();
  makeBranchRaw(repo, 'bin-a', { 'blob.bin': randomBytes(64) });
  makeBranchRaw(repo, 'bin-b', { 'blob.bin': randomBytes(64) });
  assert.deepEqual(mergeTreeConflictedFiles(repo, 'bin-a', 'bin-b'), ['blob.bin']);
});

test('H1: binary change/change conflict is detected', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'blob.bin'), randomBytes(64));
  git(repo, ['add', 'blob.bin']);
  git(repo, ['commit', '-qm', 'add blob']);
  makeBranchRaw(repo, 'bin-a', { 'blob.bin': randomBytes(64) });
  makeBranchRaw(repo, 'bin-b', { 'blob.bin': randomBytes(64) });
  assert.deepEqual(mergeTreeConflictedFiles(repo, 'bin-a', 'bin-b'), ['blob.bin']);
});

/* ------------------------------------------------------------------ */
/* H2: rename/edit conflicts were missed by the trivial merge-tree      */
/* ------------------------------------------------------------------ */

test('H2: rename + edit on the renamed file is detected', () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-qb', 'rn-a', 'main']);
  git(repo, ['mv', 'file.txt', 'renamed.txt']);
  writeFileSync(join(repo, 'renamed.txt'), FIVE.replace('line2', 'A-EDIT'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'rn-a']);
  git(repo, ['checkout', '-q', 'main']);
  makeBranch(repo, 'rn-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  assert.deepEqual(mergeTreeConflictedFiles(repo, 'rn-a', 'rn-b'), ['renamed.txt']);
});

test('H2: modify/delete is detected', () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-qb', 'rd-a', 'main']);
  git(repo, ['rm', '-q', 'file.txt']);
  git(repo, ['commit', '-qm', 'rd-a']);
  git(repo, ['checkout', '-q', 'main']);
  makeBranch(repo, 'rd-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  assert.deepEqual(mergeTreeConflictedFiles(repo, 'rd-a', 'rd-b'), ['file.txt']);
});

/* ------------------------------------------------------------------ */
/* M1: literal `<<<<<<<` lines in clean merges must not false-positive  */
/* ------------------------------------------------------------------ */

test('M1: literal conflict-marker lines in cleanly merged content are not flagged', () => {
  const repo = makeRepo();
  makeBranch(repo, 'fp-a', { 'file.txt': FIVE.replace('line1', 'A-HEAD') });
  makeBranch(repo, 'fp-b', { 'file.txt': `${FIVE}<<<<<<< shown literally in docs\n` });
  const files = mergeTreeConflictedFiles(repo, 'fp-a', 'fp-b');
  assert.deepEqual(files, [], 'clean merge misreported as conflict');
  // Sanity: a real merge agrees it is clean.
  git(repo, ['checkout', '-qb', 'fp-verify', 'fp-a']);
  git(repo, ['merge', '-q', 'fp-b', '-m', 'verify']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-D', 'fp-verify']);
});

test('M1 (legacy parser): a lone marker line without the trio is not a conflict', () => {
  const repo = makeRepo();
  makeBranch(repo, 'la-a', { 'file.txt': FIVE.replace('line1', 'A-HEAD') });
  // Even merge-tree's own `.our` label, shown literally in docs, must not flag.
  makeBranch(repo, 'la-b', { 'file.txt': `${FIVE}<<<<<<< .our is what merge-tree prints\n` });
  const base = mergeBase(repo, 'la-a', 'la-b');
  assert.deepEqual(mergeTreeConflictedFilesLegacy(repo, base, 'la-a', 'la-b'), []);
});

test('M1 (legacy parser): real conflicts still detected', () => {
  const repo = makeRepo();
  makeBranch(repo, 'lc-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'lc-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  const base = mergeBase(repo, 'lc-a', 'lc-b');
  assert.deepEqual(mergeTreeConflictedFilesLegacy(repo, base, 'lc-a', 'lc-b'), ['file.txt']);
});

/* ------------------------------------------------------------------ */
/* M2: one unforecastable pair must not kill the whole matrix           */
/* ------------------------------------------------------------------ */

test('M2: pair with no common ancestor is skipped, matrix survives', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  git(repo, ['checkout', '-q', '--orphan', 'orphan']);
  writeFileSync(join(repo, 'o.txt'), 'o\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'orphan']);
  git(repo, ['checkout', '-q', 'main']);
  const skipped: Array<[string, string]> = [];
  const collisions = textualCollisions(
    repo,
    ['agent-a', 'orphan', 'main'],
    (a, b) => skipped.push([a, b]),
  );
  assert.deepEqual(collisions, [], 'no real collisions in this topology');
  assert.equal(skipped.length, 2, 'both orphan pairs skipped via onSkip');
});

/* ------------------------------------------------------------------ */
/* M11: ceasefire's own scratch branches pollute the local matrix           */
/* ------------------------------------------------------------------ */

test('M11: ceasefire/pr/* scratch branches are excluded from the local branch list', () => {
  const repo = makeRepo();
  git(repo, ['checkout', '-qb', 'ceasefire/pr/42', 'main']);
  git(repo, ['checkout', '-q', 'main']);
  const branches = listLocalBranches(repo);
  assert.ok(!branches.includes('ceasefire/pr/42'), 'scratch branch leaked into forecast input');
  assert.ok(branches.includes('main'));
});

/* ------------------------------------------------------------------ */
/* H3: SQLite concurrency — parallel agents must not SQLITE_BUSY        */
/* ------------------------------------------------------------------ */

test('H3: parallel agents can publish concurrently without lock failures', async () => {
  const dir = tempDir('ceasefire-conc-');
  const dbPath = join(dir, 'intents.db');
  const prime = new IntentStore(dbPath);
  prime.close();

  const storeUrl = new URL('../src/intent/store.js', import.meta.url).href;
  const workerPath = join(dir, 'pub-worker.mjs');
  writeFileSync(
    workerPath,
    `import { IntentStore } from ${JSON.stringify(storeUrl)};
const store = new IntentStore(${JSON.stringify(dbPath)});
const id = process.env.WORKER_ID;
for (let i = 0; i < 25; i++) {
  store.publish('task-' + id + '-' + i, ['src/f' + i + '.ts'], { agent: 'agent-' + id, branch: 'main' });
}
store.close();
`,
  );
  const workers = ['0', '1', '2', '3'].map(
    (id) => new Worker(workerPath, { env: { ...(process.env as Record<string, string>), WORKER_ID: id } }),
  );
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          w.on('error', reject);
          w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
        }),
    ),
  );
  const check = new IntentStore(dbPath);
  try {
    assert.equal(check.list().length, 100, 'all 100 concurrent publishes landed');
  } finally {
    check.close();
  }
});

/* ------------------------------------------------------------------ */
/* M3: corrupt DB must not take down every command                       */
/* ------------------------------------------------------------------ */

test('M3: corrupt database is quarantined and the store keeps working', () => {
  const dir = tempDir('ceasefire-corrupt-');
  const dbPath = join(dir, 'intents.db');
  writeFileSync(dbPath, 'not a sqlite database');
  const store = openIntentStore(dbPath);
  try {
    store.publish('recovered', ['a.ts'], { agent: 'a', branch: 'main' });
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
  }
  const names = readdirSync(dir);
  assert.ok(
    names.some((n) => n.startsWith('intents.db.corrupt-')),
    `quarantine file missing in ${names.join(',')}`,
  );
});

test('M3: ceasefire check survives a corrupt intent DB (exit 0, not 1)', () => {
  const storeDir = tempDir('ceasefire-corrupt-cli-');
  writeFileSync(join(storeDir, 'intents.db'), 'garbage');
  const r = run(['check', 'src/a.ts'], { env: { CEASEFIRE_DIR: storeDir, CEASEFIRE_AGENT: 'a', CEASEFIRE_SYNC: '0' } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clear/i);
});

/* ------------------------------------------------------------------ */
/* M4: terminal escape injection via other agents' intent fields         */
/* ------------------------------------------------------------------ */

test('M4: sanitizeDisplay strips control characters', () => {
  assert.equal(sanitizeDisplay('a\x1b[31mRED\x07b'), 'a[31mREDb');
  assert.equal(sanitizeDisplay('plain text'), 'plain text');
  assert.equal(sanitizeDisplay('line\x00break'), 'linebreak');
});

test('M4: hostile intent fields cannot inject escapes into check output', () => {
  const storeDir = tempDir('ceasefire-inject-');
  const store = new IntentStore(join(storeDir, 'intents.db'));
  // The store validates but does not sanitize — the CLI output layer must.
  store.publish('task\x1b]0;PWNED\x07', ['src/evil.ts'], { agent: 'attacker', branch: 'main' });
  store.close();
  const r = run(['check', 'src/evil.ts'], {
    env: { CEASEFIRE_DIR: storeDir, CEASEFIRE_AGENT: 'victim', CEASEFIRE_SYNC: '0' },
  });
  assert.equal(r.code, 2, 'still advisory');
  assert.ok(!r.stdout.includes('\x1b'), 'ESC byte leaked into human output');
  assert.ok(!r.stdout.includes('\x07'), 'BEL leaked into human output');
});

/* ------------------------------------------------------------------ */
/* M5: CEASEFIRE_ALLOW_CONFLICT=1 must be logged (override telemetry)        */
/* ------------------------------------------------------------------ */

test('M5: CEASEFIRE_ALLOW_CONFLICT=1 is logged to overrides.log', () => {
  const storeDir = tempDir('ceasefire-override-');
  const holder = new IntentStore(join(storeDir, 'intents.db'));
  holder.publish('holder work', ['src/a.ts'], { agent: 'holder-agent', branch: 'main' });
  holder.close();
  const r = run(['check', 'src/a.ts'], {
    env: { CEASEFIRE_DIR: storeDir, CEASEFIRE_AGENT: 'victim', CEASEFIRE_SYNC: '0', CEASEFIRE_ALLOW_CONFLICT: '1' },
  });
  assert.equal(r.code, 0);
  const logPath = join(storeDir, 'overrides.log');
  assert.ok(existsSync(logPath), 'overrides.log was not written');
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1] as string) as {
    agent: string;
    files: string[];
    holders: string[];
    ts: string;
  };
  assert.equal(entry.agent, 'victim');
  assert.ok(entry.files.includes('src/a.ts'));
  assert.ok(entry.holders.includes('holder-agent'));
  assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0);
});

/* ------------------------------------------------------------------ */
/* M12: ambiguous --id prefix must error, not complete the wrong intent */
/* ------------------------------------------------------------------ */

test('M12: ambiguous id prefix errors instead of completing the wrong intent', () => {
  const storeDir = tempDir('ceasefire-done-amb-');
  const store = new IntentStore(join(storeDir, 'intents.db'));
  const now = Date.now();
  const mk = (id: string): Intent => ({
    id,
    agent: 'victim',
    task: `task ${id}`,
    branch: 'main',
    paths: ['a.ts'],
    createdAt: now,
    expiresAt: now + 3_600_000,
    status: 'active',
  });
  store.upsert(mk('deadbeef-1'));
  store.upsert(mk('deadbeef-2'));
  store.close();
  const r = run(['done', '--id', 'deadbeef'], {
    env: { CEASEFIRE_DIR: storeDir, CEASEFIRE_AGENT: 'victim', CEASEFIRE_SYNC: '0' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr + r.stdout, /2.*intent|more specific/i);
  const check = new IntentStore(join(storeDir, 'intents.db'));
  try {
    assert.equal(check.list({ status: 'active' }).length, 2, 'no intent may be completed on ambiguity');
  } finally {
    check.close();
  }
});
