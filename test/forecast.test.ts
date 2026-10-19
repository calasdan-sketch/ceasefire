/** Forecast: merge-tree collision detection + intent-level collisions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, makeBranch, git, FIVE } from './helpers.js';
import {
  mergeTreeConflictedFiles,
  textualCollisions,
  intentCollisions,
  buildCollisionMatrix,
  mergeBase,
} from '../src/forecast/forecast.js';
import type { Intent } from '../src/types.js';

function intent(over: Partial<Intent> & { agent: string; paths: string[] }): Intent {
  const now = Date.now();
  return {
    id: over.id ?? `id-${over.agent}`,
    task: 'some task',
    branch: 'feat/x',
    createdAt: now - 1000,
    expiresAt: now + 3_600_000,
    status: 'active',
    ...over,
  };
}

test('same-hunk edits on both branches produce a textual collision', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'agent-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  const files = mergeTreeConflictedFiles(repo, 'agent-a', 'agent-b');
  assert.deepEqual(files, ['file.txt']);
});

test('disjoint edits to the same file merge cleanly (documented git blind spot)', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line5', 'A-TAIL') });
  makeBranch(repo, 'agent-b', { 'file.txt': FIVE.replace('line1', 'B-HEAD') });
  const files = mergeTreeConflictedFiles(repo, 'agent-a', 'agent-b');
  assert.deepEqual(files, [], 'git merge-tree cannot see same-file disjoint edits');
});

test('edits to different files produce no collision', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'agent-b', { 'other.txt': 'b-other\n' });
  const collisions = textualCollisions(repo, ['agent-a', 'agent-b']);
  assert.deepEqual(collisions, []);
});

test('identical branches produce no collision', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  git(repo, ['checkout', '-qb', 'agent-a2', 'agent-a']);
  git(repo, ['checkout', '-q', 'main']);
  assert.deepEqual(textualCollisions(repo, ['agent-a', 'agent-a2']), []);
});

test('matrix reports only the colliding pair out of three branches', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'agent-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  makeBranch(repo, 'agent-c', { 'other.txt': 'c-other\n' });
  const collisions = textualCollisions(repo, ['agent-a', 'agent-b', 'agent-c']);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.severity, 'textual');
  assert.deepEqual([collisions[0]?.prA, collisions[0]?.prB].sort(), ['agent-a', 'agent-b']);
  assert.deepEqual(collisions[0]?.files, ['file.txt']);
});

test('a branch is never compared against itself', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  assert.deepEqual(textualCollisions(repo, ['agent-a', 'agent-a']), []);
});

test('mergeBase throws a clear error for unknown branches', () => {
  const repo = makeRepo();
  assert.throws(() => mergeBase(repo, 'agent-a', 'nope'), /nope|merge-base/i);
});

test('intent collisions: overlapping paths from different agents', () => {
  const now = Date.now();
  const a = intent({ agent: 'hermes', branch: 'feat/auth', paths: ['src/auth/login.ts', 'src/auth/'] });
  const b = intent({ agent: 'jarvis', branch: 'feat/pay', paths: ['src/auth/login.ts'] });
  const collisions = intentCollisions([a, b], now);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0]?.severity, 'intent');
  assert.ok(collisions[0]?.prA.includes('hermes'));
  assert.ok(collisions[0]?.prB.includes('jarvis'));
  assert.ok(collisions[0]?.files.includes('src/auth/login.ts'));
});

test('intent collisions: directory prefix counts as overlap', () => {
  const now = Date.now();
  const a = intent({ agent: 'hermes', paths: ['src/auth'] });
  const b = intent({ agent: 'jarvis', paths: ['src/auth/login.ts'] });
  assert.equal(intentCollisions([a, b], now).length, 1);
});

test('intent collisions: expired and done intents are ignored', () => {
  const now = Date.now();
  const expired = intent({ agent: 'hermes', paths: ['x.ts'], status: 'expired' });
  const done = intent({ agent: 'jarvis', paths: ['x.ts'], status: 'done' });
  const stale = intent({ agent: 'freebuff', paths: ['x.ts'], expiresAt: now - 1 });
  assert.deepEqual(intentCollisions([expired, done], now), []);
  assert.deepEqual(intentCollisions([expired, stale], now), []);
});

test('intent collisions: same agent never collides with itself', () => {
  const now = Date.now();
  const a = intent({ agent: 'hermes', id: 'one', paths: ['x.ts'] });
  const b = intent({ agent: 'hermes', id: 'two', paths: ['x.ts'] });
  assert.deepEqual(intentCollisions([a, b], now), []);
});

test('intent collisions: disjoint paths do not collide', () => {
  const now = Date.now();
  const a = intent({ agent: 'hermes', paths: ['src/a.ts'] });
  const b = intent({ agent: 'jarvis', paths: ['src/b.ts'] });
  assert.deepEqual(intentCollisions([a, b], now), []);
});

test('buildCollisionMatrix combines textual and intent collisions', () => {
  const repo = makeRepo();
  makeBranch(repo, 'agent-a', { 'file.txt': FIVE.replace('line2', 'A-EDIT') });
  makeBranch(repo, 'agent-b', { 'file.txt': FIVE.replace('line2', 'B-EDIT') });
  const now = Date.now();
  const intents = [
    intent({ agent: 'hermes', paths: ['src/auth/login.ts'] }),
    intent({ agent: 'jarvis', paths: ['src/auth/login.ts'] }),
  ];
  const matrix = buildCollisionMatrix(repo, ['agent-a', 'agent-b'], intents, now);
  const severities = matrix.map((c) => c.severity).sort();
  assert.deepEqual(severities, ['intent', 'textual']);
});
