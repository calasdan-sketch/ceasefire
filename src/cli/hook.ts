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
import { isAbsolute } from 'node:path';
import { cmdCheck, type CommandResult } from './commands.js';
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

/** Handle one Claude Code PreToolUse event (raw stdin text). */
export function runClaudeHook(input: string, opts: HookOptions): CommandResult {
  if (opts.overflow || input.length > MAX_HOOK_INPUT_BYTES) return failure('hook event exceeds the 32MB size limit');
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return failure('stdin was not a JSON hook event');
  }
  if (typeof event !== 'object' || event === null) return failure('stdin was not a JSON object');
  const e = event as Record<string, unknown>;
  const toolName = typeof e['tool_name'] === 'string' ? e['tool_name'] : '';
  const field = FILE_TOOLS[toolName];
  if (!field) return { exitCode: EXIT_CLEAR, stdout: '' }; // not a file write: no opinion
  const toolInput = e['tool_input'];
  const filePath =
    typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>)[field] : undefined;
  if (typeof filePath !== 'string' || filePath.trim() === '') return failure(`${toolName} event has no ${field}`);
  const cwd = typeof e['cwd'] === 'string' && isAbsolute(e['cwd']) ? e['cwd'] : process.cwd();

  let result: CommandResult;
  try {
    result = cmdCheck({ cwd, json: true, outsideRepo: 'ignore' }, [filePath]);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
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
