/**
 * Thin git wrappers for the forecast engine. All failures throw CeasefireGitError
 * carrying the failing command and stderr — never a bare exit code.
 */
import { execFileSync } from 'node:child_process';

export class CeasefireGitError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`ceasefire: git ${command} failed: ${stderr || '(no stderr)'}`);
    this.name = 'CeasefireGitError';
    this.command = command;
    this.stderr = stderr;
  }
}

/** Run git and return trimmed stdout. Throws CeasefireGitError on failure. */
export function git(cwd: string, args: string[]): string {
  const command = args.join(' ');
  const result = gitResult(cwd, args);
  if (result.exitCode !== 0) {
    throw new CeasefireGitError(command, result.stderr.trim() || result.stdout.trim() || 'unknown error');
  }
  return result.stdout.trim();
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git and return the exit code plus raw (untrimmed) stdout/stderr.
 * Never throws — use when a non-zero exit still carries data (e.g.
 * `git merge-tree --write-tree` exits 1 when conflicts are found).
 */
export function gitResult(cwd: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const text = (v: string | Buffer | undefined): string =>
      typeof v === 'string' ? v : v?.toString() ?? '';
    return {
      exitCode: typeof err.status === 'number' ? err.status : 1,
      stdout: text(err.stdout),
      stderr: text(err.stderr) || err.message?.trim() || 'unknown error',
    };
  }
}

/** Best-effort variant: returns null instead of throwing. */
export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Repo root, or null when cwd is not inside a git repo. */
export function findGitRoot(cwd: string): string | null {
  return tryGit(cwd, ['rev-parse', '--show-toplevel']);
}

/** Current branch name, or null on detached HEAD / outside a repo. */
export function currentBranch(cwd: string): string | null {
  return tryGit(cwd, ['branch', '--show-current']);
}

/** All local branch names, excluding ceasefire's own scratch refs (ceasefire/pr/*). */
export function listLocalBranches(cwd: string): string[] {
  const out = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((b) => b !== '' && !b.startsWith('ceasefire/'));
}

/** Merge base of two branches. Throws CeasefireGitError naming the bad branch. */
export function mergeBase(cwd: string, a: string, b: string): string {
  try {
    return git(cwd, ['merge-base', a, b]);
  } catch (e) {
    const err = e as CeasefireGitError;
    throw new CeasefireGitError(
      `merge-base ${a} ${b}`,
      `cannot find merge base for "${a}" and "${b}": ${err.stderr}`,
    );
  }
}

/** True when a remote with this name exists. */
export function hasRemote(cwd: string, name = 'origin'): boolean {
  return tryGit(cwd, ['remote', 'get-url', name]) !== null;
}
