/** Worktree forecasting: collisions in uncommitted work across git worktrees. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { git, makeRepo, tempDir } from './helpers.js';
import { forecastWorktrees, parseWorktreeList } from '../src/forecast/worktrees.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

function addWorktree(repo: string, branch: string): string {
  const dir = join(tempDir('ceasefire-wt-'), branch);
  git(repo, ['worktree', 'add', '-q', '-b', branch, dir, 'main']);
  return dir;
}

test('uncommitted same-hunk edits in two worktrees are a textual collision', () => {
  const repo = makeRepo();
  const a = addWorktree(repo, 'agent-a');
  const b = addWorktree(repo, 'agent-b');
  writeFileSync(join(a, 'file.txt'), 'line1\nAAA\nline3\nline4\nline5\n');
  writeFileSync(join(b, 'file.txt'), 'line1\nBBB\nline3\nline4\nline5\n');
  const indexBefore = readFileSync(join(repo, '.git', 'worktrees', 'agent-a', 'index'));
  const headBefore = git(a, ['rev-parse', 'HEAD']);

  const f = forecastWorktrees(repo);
  assert.equal(f.worktrees.length, 3);
  assert.equal(f.collisions.length, 1);
  const c = f.collisions[0]!;
  assert.deepEqual(c.files, ['file.txt']);
  assert.equal(c.severity, 'textual');
  assert.match(c.detail ?? '', /uncommitted/);

  // Read-only: worktree index, HEAD and status are untouched.
  assert.deepEqual(readFileSync(join(repo, '.git', 'worktrees', 'agent-a', 'index')), indexBefore);
  assert.equal(git(a, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(a, ['status', '--porcelain']), 'M file.txt');
  assert.equal(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').length, 3, 'no refs created');
});

test('disjoint uncommitted edits and clean worktrees do not collide', () => {
  const repo = makeRepo();
  const a = addWorktree(repo, 'agent-a');
  addWorktree(repo, 'agent-b');
  writeFileSync(join(a, 'other.txt'), 'changed\n');
  const f = forecastWorktrees(repo);
  assert.equal(f.collisions.length, 0);
  assert.equal(f.worktrees.filter((w) => w.dirty).length, 1);
});

test('new untracked files collide only with includeUntracked', () => {
  const repo = makeRepo();
  const a = addWorktree(repo, 'agent-a');
  const b = addWorktree(repo, 'agent-b');
  writeFileSync(join(a, 'new.ts'), 'export const a = 1;\n');
  writeFileSync(join(b, 'new.ts'), 'export const b = 2;\n');
  assert.equal(forecastWorktrees(repo).collisions.length, 0, 'tracked-only by default');
  const f = forecastWorktrees(repo, { includeUntracked: true });
  assert.equal(f.collisions.length, 1);
  assert.deepEqual(f.collisions[0]!.files, ['new.ts']);
  assert.equal(git(a, ['status', '--porcelain']), '?? new.ts', 'file stays untracked');
});

test('gitignored files are never snapshotted, even with includeUntracked', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, ['add', '.gitignore']);
  git(repo, ['commit', '-qm', 'ignore']);
  const a = addWorktree(repo, 'agent-a');
  const b = addWorktree(repo, 'agent-b');
  writeFileSync(join(a, '.env'), 'X=1\n');
  writeFileSync(join(b, '.env'), 'X=2\n');
  assert.equal(forecastWorktrees(repo, { includeUntracked: true }).collisions.length, 0);
});

test('a worktree whose directory vanished is skipped, not fatal', () => {
  const repo = makeRepo();
  const a = addWorktree(repo, 'agent-a');
  addWorktree(repo, 'agent-b');
  execFileSync('rm', ['-rf', a]);
  const f = forecastWorktrees(repo);
  assert.equal(f.worktrees.length, 2);
  assert.equal(f.skipped.length, 1);
});

test('parseWorktreeList handles bare, detached and prunable records', () => {
  const out = [
    'worktree /r', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '',
    'worktree /r2', 'HEAD ' + 'b'.repeat(40), 'detached', '',
    'worktree /r3', 'bare', '',
    'worktree /r4', 'HEAD ' + 'c'.repeat(40), 'branch refs/heads/x', 'prunable gitdir file points to non-existent location', '',
  ].join('\0');
  const list = parseWorktreeList(out);
  assert.equal(list.length, 4);
  assert.equal(list[0]!.branch, 'main');
  assert.equal(list[1]!.branch, null);
  assert.ok(list[2]!.bare);
  assert.ok(list[3]!.prunable);
});

test('CLI: conflicts --worktrees --exit-code exits 2 on collision and names both worktrees', () => {
  const repo = makeRepo();
  const a = addWorktree(repo, 'agent-a');
  const b = addWorktree(repo, 'agent-b');
  writeFileSync(join(a, 'file.txt'), 'X\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(b, 'file.txt'), 'Y\nline2\nline3\nline4\nline5\n');
  const env = { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_DIR: tempDir('ceasefire-wt-store-') };
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [CLI, 'conflicts', '--worktrees', '--exit-code'], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    stdout = err.stdout;
  }
  assert.equal(code, 2);
  assert.match(stdout, /agent-(a|b) \[worktree\] <-> agent-(a|b) \[worktree\]/);
  assert.match(stdout, /3 worktree\(s\) \(2 with uncommitted changes\)/);
  // Without --exit-code the v0.1 contract (always 0) holds.
  const out = execFileSync('node', [CLI, 'conflicts', '--worktrees', '--json'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(JSON.parse(out).collisionCount, 1);
  assert.ok(existsSync(a));
});

test('CLI: --untracked without --worktrees is a usage error', () => {
  const repo = makeRepo();
  const env = { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_DIR: tempDir('ceasefire-wt-store-') };
  assert.throws(
    () => execFileSync('node', [CLI, 'conflicts', '--untracked'], { cwd: repo, env, stdio: 'pipe' }),
    (e: { status: number }) => e.status === 1,
  );
});
