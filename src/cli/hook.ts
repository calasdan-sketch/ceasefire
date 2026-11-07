/**
 * `ceasefire hook claude` — Claude Code PreToolUse hook.
 *
 * Claude Code pipes a JSON event on stdin before each tool call
 * (https://code.claude.com/docs/en/hooks). For file-writing tools we run the
 * same check as `ceasefire check` on the target file and answer with a
 * `hookSpecificOutput` object:
 *
 *   clear                -> no output, exit 0 (normal permission flow)
 *   advisory (default)   -> `additionalContext` carrying the holder + next
 *                           actions; the edit is not interrupted
 *   advisory + --ask     -> permissionDecision "ask" (a human approves)
 *   CEASEFIRE_STRICT=1   -> permissionDecision "deny" with the reason
 *
 * Fail-closed rules: in strict mode a malformed event or an internal error
 * denies the edit (a gate must not silently open on bad setup). In
 * advisory mode it exits 1, which Claude Code shows as a non-blocking hook
 * error, so a broken setup is visible rather than silent.
 */
import { isAbsolute, dirname } from 'node:path';
import { statSync } from 'node:fs';
import { findGitRoot } from '../forecast/git.js';
import { cmdCheck, claimLease, releaseLeases, type CommandResult } from './commands.js';
import { enableFetchCaching, pruneIntentRefs } from './sync.js';
import { EXIT_CLEAR, EXIT_ERROR, EXIT_ADVISORY, EXIT_BLOCKED } from '../types.js';

/** Tools whose `tool_input` names a file about to be written. */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Largest stdin event we accept (Write events carry the whole file content). */
export const MAX_HOOK_INPUT_BYTES = 32 * 1024 * 1024;

export interface HookOptions {
  ask: boolean;
  /** Same as CEASEFIRE_STRICT=1: deny on collision, fail closed on any failure. */
  strict?: boolean;
  /**
   * Maintain an implicit sliding-TTL lease on every file this session edits
   * (also CEASEFIRE_CLAIM=1): no `ceasefire start` needed, and a session that
   * dies releases its files by itself after CEASEFIRE_LEASE_TTL (default 15m).
   */
  claim?: boolean;
  /** True when stdin exceeded MAX_HOOK_INPUT_BYTES and was truncated. */
  overflow?: boolean;
}

function decision(kind: 'ask' | 'deny', reason: string): CommandResult {
  return {
    exitCode: EXIT_CLEAR,
    stdout:
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason },
      }) + '\n',
  };
}

function context(text: string): CommandResult {
  return {
    exitCode: EXIT_CLEAR,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n',
  };
}

function failure(reason: string): CommandResult {
  if (process.env.CEASEFIRE_STRICT === '1') return decision('deny', `ceasefire hook could not run (strict mode fails closed): ${reason}`);
  return { exitCode: EXIT_ERROR, stdout: '', stderr: `ceasefire hook: ${reason}\n` };
}

/** Deepest existing ancestor directory of `file` that lies inside a git repo, or null. */
function nearestRepoDir(file: string): string | null {
  let dir = dirname(file);
  for (let i = 0; i < 4096; i++) {
    try {
      if (statSync(dir).isDirectory()) return findGitRoot(dir) ? dir : null;
    } catch {
      /* not there yet (new file in a new directory) */
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Two Claude Code sessions run by one OS user used to share one agent name
 * (the username), and a session never collides with itself, so they could not
 * warn each other. With no explicit CEASEFIRE_AGENT, the hook names the agent
 * after the event's session id instead. An explicit CEASEFIRE_AGENT always wins.
 */
function adoptSessionIdentity(e: Record<string, unknown>): void {
  if (process.env.CEASEFIRE_AGENT?.trim()) return;
  const sid = e['session_id'];
  if (typeof sid === 'string' && SESSION_ID_RE.test(sid)) process.env.CEASEFIRE_AGENT = `claude-${sid.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
}

/** SessionEnd hook: release this session's auto-leases right away instead of waiting for the TTL. */
export function runReleaseHook(input: string): CommandResult {
  try {
    const e = JSON.parse(input) as unknown;
    if (typeof e !== 'object' || e === null) return { exitCode: EXIT_CLEAR, stdout: '' };
    const rec = e as Record<string, unknown>;
    adoptSessionIdentity(rec);
    const cwd = typeof rec['cwd'] === 'string' && isAbsolute(rec['cwd']) ? rec['cwd'] : process.cwd();
    if (findGitRoot(cwd)) {
      releaseLeases({ cwd, json: true });
      pruneIntentRefs(cwd); // session end is not latency critical: the place to tidy dead refs (at most hourly)
    }
  } catch {
    /* releasing is best-effort; the TTL is the backstop */
  }
  return { exitCode: EXIT_CLEAR, stdout: '' };
}

/** Handle one Claude Code PreToolUse event (raw stdin text). */
export function runClaudeHook(input: string, opts: HookOptions): CommandResult {
  if (opts.strict) process.env.CEASEFIRE_STRICT = '1';
  enableFetchCaching(); // one edit per call: refresh remote intents at most every CEASEFIRE_FETCH_TTL_S
  if (opts.overflow || input.length > MAX_HOOK_INPUT_BYTES) return failure('hook event exceeds the 32MB size limit');
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return failure('stdin was not a JSON hook event');
  }
  if (typeof event !== 'object' || event === null) return failure('stdin was not a JSON object');
  const e = event as Record<string, unknown>;
  adoptSessionIdentity(e);
  const toolName = typeof e['tool_name'] === 'string' ? e['tool_name'] : '';
  const field = FILE_TOOLS[toolName];
  if (!field) return { exitCode: EXIT_CLEAR, stdout: '' }; // not a file write: no opinion
  const toolInput = e['tool_input'];
  const filePath =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>)[field] : undefined;
  if (typeof filePath !== 'string' || filePath.trim() === '') return failure(`${toolName} event has no ${field}`);
  const eventCwd = typeof e['cwd'] === 'string' && isAbsolute(e['cwd']) ? e['cwd'] : process.cwd();
  // The repo is the one that holds the *file*, not the session's cwd: a
  // session started in a parent folder of several worktrees edits files in
  // repos below it, and those must still be checked (strict must not fail open).
  const cwd = isAbsolute(filePath) ? nearestRepoDir(filePath) ?? eventCwd : eventCwd;

  let result: CommandResult;
  try {
    result = cmdCheck({ cwd, json: true, outsideRepo: 'ignore' }, [filePath]);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
  const claim = opts.claim === true || process.env.CEASEFIRE_CLAIM === '1';
  if (claim && result.exitCode !== EXIT_BLOCKED && (result.exitCode === EXIT_CLEAR || result.exitCode === EXIT_ADVISORY)) {
    try {
      const files = (JSON.parse(result.stdout) as { files?: unknown }).files;
      if (Array.isArray(files)) claimLease({ cwd, json: true }, files.filter((f): f is string => typeof f === 'string'));
    } catch {
      /* a check result we cannot read is handled below */
    }
  }
  if (result.exitCode === EXIT_CLEAR) return { exitCode: EXIT_CLEAR, stdout: '' };
  if (result.exitCode !== EXIT_ADVISORY && result.exitCode !== EXIT_BLOCKED) {
    return failure((result.stderr ?? '').replace(/^ceasefire: error: /, '').trim() || 'check failed');
  }
  let message = '';
  try {
    message = String((JSON.parse(result.stdout) as { message?: unknown }).message ?? '');
  } catch {
    return failure('check produced unreadable output');
  }
  if (result.exitCode === EXIT_BLOCKED) return decision('deny', message);
  return opts.ask ? decision('ask', message) : context(message);
}
