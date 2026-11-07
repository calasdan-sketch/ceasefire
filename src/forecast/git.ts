/**
 * Thin git wrappers for the forecast engine. All failures throw CeasefireGitError
 * carrying the failing command and stderr — never a bare exit code.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
export function git(cwd: string, args: string[], opts: GitCallOptions = {}): string {
  const command = args.join(' ');
  const result = gitResult(cwd, args, opts);
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
/**
 * Variables that redirect git to a different repository, index or object
 * store. ceasefire always addresses repositories by `cwd`, so an inherited
 * value (e.g. GIT_INDEX_FILE inside a pre-commit hook, GIT_DIR inside any
 * hook) would silently make it read the wrong state. Stripped from every call.
 */
export const REDIRECTING_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INDEX_VERSION',
] as const;

/** Active object quarantine (see withObjectQuarantine), or null. */
let quarantineEnv: NodeJS.ProcessEnv | null = null;

/** process.env (or `base`) minus REDIRECTING_GIT_ENV, plus the active quarantine, plus `extra`. */
export function cleanGitEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of REDIRECTING_GIT_ENV) delete env[k];
  return { ...env, ...(quarantineEnv ?? {}), ...extra };
}

/**
 * Run `fn` with every git call writing new objects (merge-tree result trees,
 * snapshot blobs and commits) into a throwaway directory instead of the
 * repository. The real object store is attached as an alternate, so every
 * existing object is still readable. The directory is deleted afterwards.
 *
 * Without this, a forecast across 81 branches left about 7,300 loose objects
 * (30 MB) behind on every run, until `git gc` pruned them two weeks later.
 * Reentrant. If the objects directory cannot be located (old git), `fn` runs
 * unquarantined, exactly as before. Do not fetch inside `fn`: fetched objects
 * would be deleted with the quarantine while their refs stayed.
 */
export function withObjectQuarantine<T>(cwd: string, fn: () => T): T {
  const end = beginObjectQuarantine(cwd);
  try {
    return fn();
  } finally {
    end();
  }
}

/** Start a quarantine and return the function that ends (and deletes) it. Reentrant: an inner call returns a no-op. */
export function beginObjectQuarantine(cwd: string): () => void {
  if (quarantineEnv !== null) return () => undefined;
  const objects = tryGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (!objects) return () => undefined;
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ceasefire-q-'));
  } catch {
    return () => undefined;
  }
  const inherited = process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  // A path that contains the list separator (a ':' on Linux) or a quote must be C-style quoted, or git splits it in two.
  const entry = objects.includes(delimiter) || objects.includes('"') ? `"${objects.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : objects;
  quarantineEnv = {
    GIT_OBJECT_DIRECTORY: dir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: inherited ? `${entry}${delimiter}${inherited}` : entry,
  };
  return () => {
    quarantineEnv = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp directory is harmless */
    }
  };
}

export interface GitCallOptions {
  /** Extra env vars, applied on top of the cleaned environment. */
  env?: NodeJS.ProcessEnv;
  /** Kill git after this many ms (reported as a failure). */
  timeoutMs?: number;
  /** stdin for git. */
  input?: string;
}

export function gitResult(cwd: string, args: string[], opts: GitCallOptions = {}): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      env: cleanGitEnv(opts.env),
      encoding: 'utf8',
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
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
export function tryGit(cwd: string, args: string[], opts: GitCallOptions = {}): string | null {
  try {
    return git(cwd, args, opts);
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

/**
 * Commit ids for many ref names in ONE git process (`cat-file --batch-check`),
 * instead of one `rev-parse` each. Names git cannot resolve to a commit are
 * absent from the result. Names containing a newline or NUL are refused.
 */
export function resolveCommits(cwd: string, names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const ok = names.filter((n) => n !== '' && !/[\n\0]/.test(n) && !n.startsWith('-'));
  if (ok.length === 0) return out;
  const r = gitResult(cwd, ['cat-file', '--batch-check'], { input: ok.map((n) => `${n}^{commit}`).join('\n') + '\n' });
  if (r.exitCode !== 0) return out;
  const lines = r.stdout.split('\n');
  ok.forEach((name, i) => {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) commit \d+$/.exec((lines[i] ?? '').trim());
    if (m) out.set(name, m[1] as string);
  });
  return out;
}
