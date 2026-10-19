/**
 * MCP tool implementations for ceasefire.
 *
 * `ceasefire_check` mirrors `ceasefire check --json <files>` and `ceasefire_conflicts`
 * mirrors `ceasefire conflicts --json`, invoked as a subprocess of the ceasefire
 * binary. Subprocess (rather than importing core) keeps the MCP server
 * decoupled from core's in-progress interfaces and guarantees the tools
 * report exactly what the CLI reports.
 *
 * Exit-code semantics: 0/2/3 with parseable JSON is a *successful* check
 * (clear/advisory/block are data, not tool failures). Only a spawn failure,
 * timeout, or unparseable output becomes an MCP `isError`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const CHECK_TOOL: ToolDefinition = {
  name: 'ceasefire_check',
  description:
    'Check whether editing the given files risks a merge collision with other agents\u2019 active work. ' +
    'Mirrors `ceasefire check --json <files>`. Advisory only — it never blocks; it reports a verdict ' +
    '(clear, advisory, or block) with the colliding files and severity.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative file paths you plan to edit.',
      },
      cwd: {
        type: 'string',
        description: 'Repository working directory. Defaults to the MCP server process cwd.',
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
};

export const CONFLICTS_TOOL: ToolDefinition = {
  name: 'ceasefire_conflicts',
  description:
    'Machine-readable collision forecast across branches/PRs in this repo. ' +
    'Mirrors `ceasefire conflicts --json`. Returns the collision matrix: per-pair files and severity.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Repository working directory. Defaults to the MCP server process cwd.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export interface CeasefireRunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface CeasefireJsonResult {
  /** True when ceasefire ran and stdout parsed as JSON (any exit code). */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
  timedOut: boolean;
  error?: string;
}

/**
 * Locate the ceasefire CLI binary: CEASEFIRE_BIN env first, then the sibling CLI in
 * the dist layout (dist/src/mcp/tools.js -> dist/src/cli.js), then PATH.
 */
export function resolveCeasefireBin(): string {
  const fromEnv = process.env['CEASEFIRE_BIN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, '..', 'cli.js'), join(here, '..', 'cli', 'index.js')]) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore — fall through to PATH lookup
  }
  return 'ceasefire';
}

interface ExecError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

function tryParseJson(stdout: string): { ok: boolean; value: unknown; error?: string } {
  try {
    return { ok: true, value: JSON.parse(stdout) as unknown };
  } catch (err) {
    return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run `ceasefire ... --json` and capture the machine-readable result. Never throws. */
export function invokeCeasefireJson(
  bin: string,
  args: string[],
  opts: CeasefireRunOptions = {},
): Promise<CeasefireJsonResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // The published ceasefire binary is a compiled .js file (dist/cli.js) with no
  // shebang — it must be launched through node, not exec'd directly.
  const isJs = /\.m?js$/.test(bin);
  const cmd = isJs ? process.execPath : bin;
  const fullArgs = isJs ? [bin, ...args] : args;
  return new Promise((resolve) => {
    execFile(
      cmd,
      fullArgs,
      { cwd: opts.cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = stdout ?? (err as ExecError | null)?.stdout ?? '';
        const errOut = stderr ?? (err as ExecError | null)?.stderr ?? '';
        if (err === null) {
          const parsed = tryParseJson(out);
          resolve({
            ok: parsed.ok,
            exitCode: 0,
            stdout: out,
            stderr: errOut,
            json: parsed.value,
            timedOut: false,
            ...(parsed.ok ? {} : { error: `ceasefire printed invalid JSON: ${parsed.error}` }),
          });
          return;
        }
        const e = err as ExecError;
        if (e.killed === true) {
          resolve({
            ok: false, exitCode: null, stdout: out, stderr: errOut,
            json: null, timedOut: true, error: `ceasefire timed out after ${timeoutMs}ms`,
          });
          return;
        }
        if (e.code === 'ENOENT') {
          resolve({
            ok: false, exitCode: null, stdout: '', stderr: '', json: null, timedOut: false,
            error: `could not spawn ceasefire binary "${bin}": not found (set CEASEFIRE_BIN to its path)`,
          });
          return;
        }
        const exitCode = typeof e.code === 'number' ? e.code : null;
        const parsed = tryParseJson(out);
        resolve({
          ok: parsed.ok,
          exitCode,
          stdout: out,
          stderr: errOut,
          json: parsed.value,
          timedOut: false,
          error: parsed.ok
            ? `ceasefire exited with code ${exitCode}: ${errOut.slice(0, 500)}`
            : `ceasefire exited with code ${exitCode} and printed invalid JSON: ${out.slice(0, 500)}`,
        });
      },
    );
  });
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function toMcpResult(res: CeasefireJsonResult): McpToolResult {
  if (!res.ok) {
    return { content: [{ type: 'text', text: `ceasefire failed: ${res.error ?? 'unknown error'}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(res.json, null, 2) }] };
}

export interface CheckInput {
  files: string[];
  cwd?: string;
}

function runOptions(base: CeasefireRunOptions, cwd: string | undefined): CeasefireRunOptions {
  const out: CeasefireRunOptions = {};
  if (base.timeoutMs !== undefined) out.timeoutMs = base.timeoutMs;
  const resolved = cwd ?? base.cwd;
  if (resolved !== undefined) out.cwd = resolved;
  return out;
}

/** Implements the `ceasefire_check` tool. */
export async function runCheckTool(
  bin: string,
  input: CheckInput,
  opts: CeasefireRunOptions = {},
): Promise<McpToolResult> {
  if (input.files.length === 0) {
    return { content: [{ type: 'text', text: 'ceasefire_check needs at least one file path.' }], isError: true };
  }
  const res = await invokeCeasefireJson(bin, ['check', '--json', '--', ...input.files], runOptions(opts, input.cwd));
  return toMcpResult(res);
}

export interface ConflictsInput {
  cwd?: string;
}

/** Implements the `ceasefire_conflicts` tool. */
export async function runConflictsTool(
  bin: string,
  input: ConflictsInput,
  opts: CeasefireRunOptions = {},
): Promise<McpToolResult> {
  const res = await invokeCeasefireJson(bin, ['conflicts', '--json'], runOptions(opts, input.cwd));
  return toMcpResult(res);
}
