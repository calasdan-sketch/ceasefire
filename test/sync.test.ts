/** Git-refs broadcast: intents published in one clone are visible in another. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, tempDir } from './helpers.js';
import { broadcastIntent, fetchRemoteIntents } from '../src/cli/sync.js';
import { IntentStore } from '../src/intent/store.js';
import type { Intent } from '../src/types.js';

function withSyncEnabled<T>(fn: () => T): T {
  const prev = process.env.CEASEFIRE_SYNC;
  delete process.env.CEASEFIRE_SYNC;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CEASEFIRE_SYNC;
    else process.env.CEASEFIRE_SYNC = prev;
  }
}

/** Two clones (a, b) of one local bare remote. */
function twoClones(): { bare: string; a: string; b: string } {
  const bare = tempDir('ceasefire-bare-');
  git(bare, ['init', '--bare', '-q']);
  const seed = tempDir('ceasefire-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 't@t.t']);
  git(seed, ['config', 'user.name', 't']);
  writeFileSync(join(seed, 'f.txt'), 'x\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-q', 'origin', 'main']);
  const a = tempDir('ceasefire-clone-a-');
  const b = tempDir('ceasefire-clone-b-');
  git(a, ['clone', '-q', bare, '.']);
  git(b, ['clone', '-q', bare, '.']);
  for (const r of [a, b]) {
    git(r, ['config', 'user.email', 't@t.t']);
    git(r, ['config', 'user.name', 't']);
  }
  return { bare, a, b };
}

function publishedIntent(): Intent {
  const dir = tempDir('ceasefire-sync-store-');
  const store = new IntentStore(join(dir, 'intents.db'));
  const intent = store.publish('cross-machine work', ['src/a.ts'], { agent: 'hermes', branch: 'feat/x' });
  store.close();
  return intent;
}

test('broadcastIntent pushes the intent ref; the other clone fetches it', () => {
  const { a, b } = twoClones();
  const intent = publishedIntent();
  withSyncEnabled(() => {
    assert.equal(broadcastIntent(a, intent), true);
    const seen = fetchRemoteIntents(b);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, intent.id);
    assert.equal(seen[0]?.task, 'cross-machine work');
    assert.deepEqual(seen[0]?.paths, ['src/a.ts']);
    assert.equal(seen[0]?.agent, 'hermes');
  });
});

test('fetchRemoteIntents skips malformed refs', () => {
  const { b } = twoClones();
  withSyncEnabled(() => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: b,
      input: 'not json{{{',
      encoding: 'utf8',
    }).trim();
    git(b, ['update-ref', 'refs/ceasefire/intents/garbage', blob]);
    const seen = fetchRemoteIntents(b);
    assert.deepEqual(seen, [], 'malformed ref must be skipped, not crash');
  });
});

test('fetchRemoteIntents skips oversized and invalid intent blobs', () => {
  const { b } = twoClones();
  withSyncEnabled(() => {
    const plant = (ref: string, payload: unknown): void => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: b,
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
      }).trim();
      git(b, ['update-ref', `refs/ceasefire/intents/${ref}`, blob]);
    };
    const valid = { id: 'ok-1', agent: 'a', task: 't', branch: 'b', paths: ['x'], createdAt: 1, expiresAt: 9999999999999, status: 'active' };
    // Oversized blob (100KB task) — must not bloat the local DB.
    plant('big', { ...valid, id: 'big-1', task: 'x'.repeat(100_000) });
    // Wrong field types.
    plant('wrong', { ...valid, id: 'wrong-1', paths: 'not-an-array' });
    // Ref-unsafe id inside the payload.
    plant('evil', { ...valid, id: '../../evil' });
    // A good one, to prove the filter is selective.
    plant('good', { ...valid, id: 'good-1' });
    const seen = fetchRemoteIntents(b);
    assert.deepEqual(
      seen.map((i) => i.id),
      ['good-1'],
      'only the valid intent survives validation',
    );
  });
});

test('CEASEFIRE_SYNC=0 disables all broadcast behavior', () => {
  const { a, b } = twoClones();
  const intent = publishedIntent();
  process.env.CEASEFIRE_SYNC = '0';
  try {
    assert.equal(broadcastIntent(a, intent), false);
    assert.deepEqual(fetchRemoteIntents(b), []);
  } finally {
    delete process.env.CEASEFIRE_SYNC;
  }
});

test('broadcast without an origin remote is a silent no-op', () => {
  const repo = tempDir('ceasefire-noorigin-');
  git(repo, ['init', '-q', '-b', 'main']);
  const intent = publishedIntent();
  withSyncEnabled(() => {
    assert.equal(broadcastIntent(repo, intent), false);
    assert.deepEqual(fetchRemoteIntents(repo), []);
  });
});

// --- CLI-level cross-machine flow ---

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

function runCli(args: string[], cwd: string, env: Record<string, string>): { code: number; stdout: string } {
  const fullEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CEASEFIRE_DIR: tempDir('ceasefire-cli-store-'),
    CEASEFIRE_AGENT: 'hermes',
    ...env,
  };
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      env: fullEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? '') };
  }
}

test('done on a second machine completes the broadcast intent', () => {
  const { a, b } = twoClones();
  withSyncEnabled(() => {
    assert.equal(runCli(['start', 'x-machine task', '--paths', 'f.txt'], a, {}).code, 0);
    // Machine B sees the advisory before done.
    assert.equal(runCli(['check', 'f.txt'], b, { CEASEFIRE_AGENT: 'jarvis' }).code, 2);
    // The holder completes from machine B.
    const d = runCli(['done'], b, {});
    assert.equal(d.code, 0);
    assert.match(d.stdout, /completed/);
    // Machine A no longer reports the advisory.
    assert.equal(runCli(['check', 'f.txt'], a, { CEASEFIRE_AGENT: 'jarvis' }).code, 0);
  });
});
