/** CLI: exit codes, env knobs, and the blocked-agent message format. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeRepo, makeBranch, FIVE, tempDir } from './helpers.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const storeDir = opts.env?.CEASEFIRE_DIR ?? tempDir('ceasefire-cli-store-');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CEASEFIRE_DIR: storeDir,
    CEASEFIRE_AGENT: 'test-agent',
    CEASEFIRE_SYNC: '0',
    ...opts.env,
  };
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: opts.cwd ?? tempDir('ceasefire-cli-cwd-'),
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

const JSON_RE = /\{[\s\S]*\}/;

test('check is clear with no intents: exit 0', () => {
  const r = run(['check', 'src/a.ts']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clear/i);
});

test('check with no files errors with usage, exit 1', () => {
  const r = run(['check']);
  assert.equal(r.code, 1);
  assert.match(r.stderr + r.stdout, /usage|files/i);
});

test('start publishes an intent; done completes it', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  const s = run(['start', 'refactor login', '--paths', 'src/a.ts', 'src/b.ts'], { env });
  assert.equal(s.code, 0);
  assert.match(s.stdout, /intent/i);

  // Another agent sees the advisory.
  const c = run(['check', 'src/a.ts'], { env: { ...env, CEASEFIRE_AGENT: 'other-agent' } });
  assert.equal(c.code, 2);

  const d = run(['done'], { env });
  assert.equal(d.code, 0);

  const c2 = run(['check', 'src/a.ts'], { env: { ...env, CEASEFIRE_AGENT: 'other-agent' } });
  assert.equal(c2.code, 0);
});

test('done with no active intent exits 1 with a clear error', () => {
  const r = run(['done']);
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /no active intent/i);
});

test('blocked-agent message: verdict-first, named holder, numbered actions, suggest, override', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  run(['start', 'refactor login', '--paths', 'src/auth/login.ts'], { env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  const r = run(['check', 'src/auth/login.ts'], { env: { ...env, CEASEFIRE_AGENT: 'jarvis' } });
  assert.equal(r.code, 2);
  const msg = r.stdout;
  assert.match(msg, /^CEASEFIRE VERDICT:/m, 'verdict comes first');
  assert.match(msg, /hermes/, 'holder is named');
  assert.match(msg, /refactor login/, 'intent task is shown');
  assert.match(msg, /^\s*1\./m, 'numbered next actions');
  assert.match(msg, /ceasefire suggest/, 'points at ceasefire suggest');
  assert.match(msg, /CEASEFIRE_ALLOW_CONFLICT=1/, 'override is documented');
});

test('CEASEFIRE_ALLOW_CONFLICT=1 downgrades advisory to clear', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  run(['start', 'work', '--paths', 'x.ts'], { env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  const r = run(['check', 'x.ts'], { env: { ...env, CEASEFIRE_AGENT: 'jarvis', CEASEFIRE_ALLOW_CONFLICT: '1' } });
  assert.equal(r.code, 0);
});

test('CEASEFIRE_STRICT=1 turns advisory into a hard block, exit 3', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  run(['start', 'work', '--paths', 'x.ts'], { env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  const r = run(['check', 'x.ts'], { env: { ...env, CEASEFIRE_AGENT: 'jarvis', CEASEFIRE_STRICT: '1' } });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /BLOCKED/);
});

test('--json and CEASEFIRE_JSON=1 both produce parseable JSON', () => {
  const r1 = run(['check', 'a.ts'], { env: { CEASEFIRE_JSON: '1' } });
  const p1 = JSON.parse(r1.stdout.match(JSON_RE)![0]) as { verdict: string };
  assert.equal(p1.verdict, 'clear');
  const r2 = run(['check', 'a.ts', '--json']);
  const p2 = JSON.parse(r2.stdout.match(JSON_RE)![0]) as { verdict: string };
  assert.equal(p2.verdict, 'clear');
});

test('check --json reports contentions structurally', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  run(['start', 'migrate db', '--paths', 'db/schema.sql'], { env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  const r = run(['check', 'db/schema.sql', '--json'], { env: { ...env, CEASEFIRE_AGENT: 'jarvis' } });
  assert.equal(r.code, 2);
  const parsed = JSON.parse(r.stdout.match(JSON_RE)![0]) as {
    verdict: string; contentions: Array<{ holder: string; task: string; files: string[] }>;
  };
  assert.equal(parsed.verdict, 'advisory');
  assert.equal(parsed.contentions.length, 1);
  assert.equal(parsed.contentions[0]?.holder, 'hermes');
  assert.equal(parsed.contentions[0]?.task, 'migrate db');
  assert.deepEqual(parsed.contentions[0]?.files, ['db/schema.sql']);
});

test('own intents never block the holder', () => {
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir, CEASEFIRE_AGENT: 'hermes' };
  run(['start', 'my work', '--paths', 'x.ts'], { env });
  const r = run(['check', 'x.ts'], { env });
  assert.equal(r.code, 0);
});

test('conflicts --json reports the textual collision matrix on a fixture repo', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'agent-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  const r = run(['conflicts', '--json'], { cwd: repo });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout.match(JSON_RE)![0]) as {
    collisions: Array<{ severity: string; files: string[] }>;
  };
  const textual = parsed.collisions.filter((c) => c.severity === 'textual');
  assert.equal(textual.length, 1);
  assert.deepEqual(textual[0]?.files, ['file.txt']);
});

test('conflicts on a clean repo reports an empty matrix', () => {
  const repo = makeRepo();
  const r = run(['conflicts', '--json'], { cwd: repo });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout.match(JSON_RE)![0]) as { collisions: unknown[] };
  assert.deepEqual(parsed.collisions, []);
});

test('suggest offers unclaimed alternatives when blocked', () => {
  const repo = makeRepo();
  const storeDir = tempDir('ceasefire-cli-store-');
  const env = { CEASEFIRE_DIR: storeDir };
  run(['start', 'auth work', '--paths', 'file.txt'], { env: { ...env, CEASEFIRE_AGENT: 'hermes' }, cwd: repo });
  const r = run(['suggest', 'file.txt'], { env: { ...env, CEASEFIRE_AGENT: 'jarvis' }, cwd: repo });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /other\.txt/, 'suggests a file nobody claimed');
  assert.match(r.stdout, /hermes/, 'names who holds the blocked file');
});

test('init installs a pre-push hook and a workflow stub in a git repo', () => {
  const repo = makeRepo();
  const r = run(['init'], { cwd: repo });
  assert.equal(r.code, 0);
  const hook = join(repo, '.git', 'hooks', 'pre-push');
  assert.ok(existsSync(hook), 'pre-push hook installed');
  const stat = readFileSync(hook, 'utf8');
  assert.match(stat, /ceasefire/);
  const wf = join(repo, '.github', 'workflows', 'ceasefire.yml');
  assert.ok(existsSync(wf), 'workflow stub installed');
  assert.match(readFileSync(wf, 'utf8'), /ceasefire/);
});

test('init is idempotent: second run keeps the hook working', () => {
  const repo = makeRepo();
  assert.equal(run(['init'], { cwd: repo }).code, 0);
  assert.equal(run(['init'], { cwd: repo }).code, 0);
  assert.ok(existsSync(join(repo, '.git', 'hooks', 'pre-push')));
});

test('init outside a git repo exits 1 with a clear error', () => {
  const dir = tempDir('ceasefire-nogit-');
  const r = run(['init'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /not a git repository/i);
});

test('--version and --help exit 0', () => {
  assert.equal(run(['--version']).code, 0);
  const h = run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /check|start|done|conflicts|suggest/);
});

test('unknown command exits 1', () => {
  const r = run(['frobnicate']);
  assert.equal(r.code, 1);
});
