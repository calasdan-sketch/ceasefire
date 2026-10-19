/** Read-only adapter tests: claimlock's shortleash fleet claims as advisory signals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  readActiveClaims,
  claimsForPaths,
  toClaimSignals,
  defaultClaimDbPath,
  type ClaimlockClaim,
} from '../../src/claimlock/adapter.js';

const NOW = 1_800_000_000; // fixed "now" (unix seconds) for determinism

function fixtureDb(): { path: string; claims: ClaimlockClaim[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ceasefire-claimlock-'));
  const path = join(dir, 'fleet.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE claims (
    rowid INTEGER PRIMARY KEY,
    claim_id TEXT,
    path TEXT,
    owner TEXT,
    note TEXT,
    expires_at INTEGER,
    created_at INTEGER
  )`);
  const active: ClaimlockClaim = {
    claimId: 'abc123',
    path: '/repo/src/auth',
    owner: 'hermes',
    note: 'refactoring login',
    expiresAt: NOW + 600,
    createdAt: NOW - 60,
  };
  const expired: ClaimlockClaim = {
    claimId: 'dead99',
    path: '/repo/src/pay.ts',
    owner: 'jarvis',
    note: 'old work',
    expiresAt: NOW - 1,
    createdAt: NOW - 3600,
  };
  const insert = db.prepare(
    'INSERT INTO claims (claim_id, path, owner, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run(active.claimId, active.path, active.owner, active.note, active.expiresAt, active.createdAt);
  insert.run(expired.claimId, expired.path, expired.owner, expired.note, expired.expiresAt, expired.createdAt);
  db.close();
  return { path, claims: [active] };
}

function rowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

test('reads only active claims; expired claims are filtered out', () => {
  const { path } = fixtureDb();
  const claims = readActiveClaims(path, NOW);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.claimId, 'abc123');
  assert.equal(claims[0]?.owner, 'hermes');
});

test('claim fields are mapped faithfully', () => {
  const { path, claims } = fixtureDb();
  const [got] = readActiveClaims(path, NOW);
  assert.deepEqual(got, claims[0]);
});

test('missing database returns an empty list (claimlock simply not in use)', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'ceasefire-cl-')), 'nope.db');
  assert.deepEqual(readActiveClaims(missing, NOW), []);
});

test('unreadable/corrupt database returns an empty list instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceasefire-cl-'));
  const bad = join(dir, 'bad.db');
  writeFileSync(bad, 'this is not sqlite');
  assert.deepEqual(readActiveClaims(bad, NOW), []);
});

test('reading never writes: row count and data are unchanged', () => {
  const { path } = fixtureDb();
  const before = rowCount(path);
  readActiveClaims(path, NOW);
  readActiveClaims(path, NOW);
  assert.equal(rowCount(path), before);
});

test('default path points at shortleash fleet db', () => {
  assert.ok(defaultClaimDbPath().endsWith(join('.shortleash', 'fleet.db')));
});

test('claimsForPaths: exact path match', () => {
  const claims: ClaimlockClaim[] = [
    { claimId: 'a', path: '/repo/src/auth', owner: 'h', note: '', expiresAt: 1, createdAt: 1 },
  ];
  const hits = claimsForPaths(claims, ['/repo/src/auth']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.claim.claimId, 'a');
});

test('claimsForPaths: nested paths overlap in both directions (claimlock semantics)', () => {
  const claims: ClaimlockClaim[] = [
    { claimId: 'dir', path: '/repo/src/auth', owner: 'h', note: '', expiresAt: 1, createdAt: 1 },
  ];
  // query is a file inside the claimed dir
  assert.equal(claimsForPaths(claims, ['/repo/src/auth/login.ts']).length, 1);
  // query is a parent of the claimed dir
  assert.equal(claimsForPaths(claims, ['/repo/src']).length, 1);
});

test('claimsForPaths: sibling prefix does not overlap (/repo/src/authx vs /repo/src/auth)', () => {
  const claims: ClaimlockClaim[] = [
    { claimId: 'a', path: '/repo/src/auth', owner: 'h', note: '', expiresAt: 1, createdAt: 1 },
  ];
  assert.deepEqual(claimsForPaths(claims, ['/repo/src/authx/login.ts']), []);
  assert.deepEqual(claimsForPaths(claims, ['/repo/src/other.ts']), []);
});

test('claimsForPaths: first matching claim wins per path', () => {
  const mk = (claimId: string, path: string): ClaimlockClaim => ({
    claimId, path, owner: 'h', note: '', expiresAt: 1, createdAt: 1,
  });
  const hits = claimsForPaths([mk('one', '/repo/src'), mk('two', '/repo/src/a.ts')], ['/repo/src/a.ts']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.claim.claimId, 'one');
});

test('toClaimSignals maps claims to advisory signals with ttl', () => {
  const { claims } = fixtureDb();
  const [signal] = toClaimSignals(claims, NOW);
  assert.equal(signal?.source, 'claimlock');
  assert.equal(signal?.claimId, 'abc123');
  assert.equal(signal?.path, '/repo/src/auth');
  assert.equal(signal?.holder, 'hermes');
  assert.equal(signal?.note, 'refactoring login');
  assert.equal(signal?.expiresInSec, 600);
});

test('toClaimSignals relativizes absolute claim paths against baseDir (no homedir leak)', () => {
  const claim: ClaimlockClaim = {
    claimId: 'c1',
    path: '/home/dan/repo/src/a.ts',
    owner: 'hermes',
    note: '',
    expiresAt: NOW + 600,
    createdAt: NOW - 60,
  };
  const [rel] = toClaimSignals([claim], NOW, '/home/dan/repo');
  assert.equal(rel?.path, 'src/a.ts', 'repo-relative when under baseDir');
  const [outside] = toClaimSignals([claim], NOW, '/somewhere/else');
  assert.equal(outside?.path, 'a.ts', 'basename fallback outside baseDir');
  const [raw] = toClaimSignals([claim], NOW);
  assert.equal(raw?.path, '/home/dan/repo/src/a.ts', 'unchanged without baseDir');
});
