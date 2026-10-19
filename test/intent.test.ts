/** Intent store: lifecycle, TTL expiry, validation, persistence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './helpers.js';
import { IntentStore, DEFAULT_TTL_MS } from '../src/intent/store.js';
import type { Intent } from '../src/types.js';

function freshStore(): { dir: string; store: IntentStore } {
  const dir = tempDir('ceasefire-intent-');
  return { dir, store: new IntentStore(join(dir, 'intents.db')) };
}

const PUB = { agent: 'agent-a', branch: 'feat/x' };

test('publish creates an active intent with 4h default TTL', () => {
  const { store } = freshStore();
  const before = Date.now();
  const intent = store.publish('refactor login', ['src/auth/login.ts'], PUB);
  const after = Date.now();
  assert.ok(intent.id.length >= 8);
  assert.equal(intent.agent, 'agent-a');
  assert.equal(intent.task, 'refactor login');
  assert.equal(intent.branch, 'feat/x');
  assert.deepEqual(intent.paths, ['src/auth/login.ts']);
  assert.equal(intent.status, 'active');
  assert.ok(intent.createdAt >= before && intent.createdAt <= after);
  assert.equal(intent.expiresAt - intent.createdAt, DEFAULT_TTL_MS);
  assert.equal(DEFAULT_TTL_MS, 4 * 60 * 60 * 1000);
  store.close();
});

test('publish honors a custom ttlMs', () => {
  const { store } = freshStore();
  const intent = store.publish('quick fix', ['a.ts'], { ...PUB, ttlMs: 60_000 });
  assert.equal(intent.expiresAt - intent.createdAt, 60_000);
  store.close();
});

test('publish validates its inputs', () => {
  const { store } = freshStore();
  assert.throws(() => store.publish('', ['a.ts'], PUB), /task/i);
  assert.throws(() => store.publish('   ', ['a.ts'], PUB), /task/i);
  assert.throws(() => store.publish('t', [], PUB), /path/i);
  assert.throws(() => store.publish('t', [''], PUB), /path/i);
  assert.throws(() => store.publish('t', ['a.ts'], { ...PUB, ttlMs: 0 }), /ttl/i);
  assert.throws(() => store.publish('t', ['a.ts'], { ...PUB, ttlMs: -5 }), /ttl/i);
  store.close();
});

test('list returns published intents; paths survive a JSON round-trip', () => {
  const { store } = freshStore();
  const weird = ['src/a b.ts', 'dir/ünïcode.ts', "it's.ts"];
  const created = store.publish('weird paths', weird, PUB);
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.paths, weird);
  assert.equal(listed[0]?.id, created.id);
  store.close();
});

test('complete marks an intent done; unknown id returns null', () => {
  const { store } = freshStore();
  const intent = store.publish('task', ['a.ts'], PUB);
  const done = store.complete(intent.id);
  assert.equal(done?.status, 'done');
  assert.equal(store.get(intent.id)?.status, 'done');
  assert.equal(store.complete('no-such-id'), null);
  assert.deepEqual(store.list({ status: 'active' }), []);
  store.close();
});

test('expire flips past-due intents to expired and reports the count', () => {
  const { store } = freshStore();
  const i1 = store.publish('old', ['a.ts'], { ...PUB, ttlMs: 1 });
  const i2 = store.publish('older', ['b.ts'], { ...PUB, ttlMs: 1 });
  // Both intents carry a 1ms TTL, so any "now" in the future expires them.
  const expired = store.expire(Date.now() + 60_000);
  assert.equal(expired, 2);
  assert.equal(store.get(i1.id)?.status, 'expired');
  assert.equal(store.expire(), 0);
  store.close();
});

test('list triggers expiry lazily: past-due intents show as expired', () => {
  const { store } = freshStore();
  const intent = store.publish('short', ['a.ts'], { ...PUB, ttlMs: 1 });
  const listed = store.list({ now: intent.expiresAt + 1 });
  assert.equal(listed[0]?.status, 'expired');
  assert.deepEqual(store.list({ status: 'active', now: intent.expiresAt + 1 }), []);
  store.close();
});

test('list filters by agent and status', () => {
  const { store } = freshStore();
  const a = store.publish('a-task', ['a.ts'], { agent: 'agent-a', branch: 'b1' });
  store.publish('b-task', ['b.ts'], { agent: 'agent-b', branch: 'b2' });
  store.complete(a.id);
  assert.equal(store.list({ agent: 'agent-b' }).length, 1);
  assert.equal(store.list({ status: 'done' }).length, 1);
  assert.equal(store.list({ status: 'active' }).length, 1);
  store.close();
});

test('intents persist across store instances on the same file', () => {
  const { dir } = freshStore();
  const dbPath = join(dir, 'intents.db');
  const s1 = new IntentStore(dbPath);
  const created = s1.publish('persist me', ['x.ts'], PUB);
  s1.close();
  const s2 = new IntentStore(dbPath);
  assert.equal(s2.get(created.id)?.task, 'persist me');
  s2.close();
});

test('get returns null for unknown ids', () => {
  const { store } = freshStore();
  assert.equal(store.get('missing'), null);
  store.close();
});

test('upsert imports a foreign intent so complete() works on it', () => {
  const { store } = freshStore();
  const foreign: Intent = {
    id: 'remote-1',
    agent: 'hermes',
    task: 'cross-machine task',
    branch: 'feat/x',
    paths: ['x.ts'],
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 3_600_000,
    status: 'active',
  };
  assert.equal(store.get('remote-1'), null);
  store.upsert(foreign);
  assert.equal(store.get('remote-1')?.task, 'cross-machine task');
  assert.equal(store.complete('remote-1')?.status, 'done');
  // Re-upsert replaces wholesale (e.g. a done rebroadcast overwrites active).
  store.upsert({ ...foreign, status: 'done' });
  assert.equal(store.get('remote-1')?.status, 'done');
  store.close();
});
