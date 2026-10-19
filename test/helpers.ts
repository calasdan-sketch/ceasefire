/** Shared fixtures for ceasefire tests: temp git repos with known branch topologies. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempDir(prefix: string): string {
  // CEASEFIRE_TEST_TMP lets CI / crowded machines redirect fixture repos off /tmp.
  const base = process.env.CEASEFIRE_TEST_TMP?.trim() || tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Minimal repo: main branch with file.txt (5 lines) + other.txt committed. */
export function makeRepo(): string {
  const dir = tempDir('ceasefire-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'ceasefire@test.dev']);
  git(dir, ['config', 'user.name', 'ceasefire-test']);
  writeFileSync(join(dir, 'file.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(dir, 'other.txt'), 'other\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

/** Create a branch from `from`, apply file edits (path -> new content), commit. */
export function makeBranch(repo: string, name: string, edits: Record<string, string>, from = 'main'): void {
  git(repo, ['checkout', '-qb', name, from]);
  for (const [p, content] of Object.entries(edits)) {
    writeFileSync(join(repo, p), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', name]);
  git(repo, ['checkout', '-q', 'main']);
}

export const FIVE = 'line1\nline2\nline3\nline4\nline5\n';
