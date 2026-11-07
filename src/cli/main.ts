/**
 * CLI entry logic (argv parsing, dispatch, exit codes). Loaded by src/cli.ts
 * after it installs the warning filter, so node:sqlite's experimental
 * warning never pollutes agent-facing output.
 */
import { readFileSync } from 'node:fs';
import { cmdCheck, cmdConflicts, cmdDoctor, cmdDone, cmdInit, cmdList, cmdStart, cmdStatus, cmdSuggest, parseTtl, type Ctx } from './commands.js';
import { runClaudeHook, runReleaseHook, MAX_HOOK_INPUT_BYTES } from './hook.js';
import { EXIT_ERROR } from '../types.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = version();
const MAX_STDIN_PATH_BYTES = 4 * 1024 * 1024;

interface Parsed {
  command?: string;
  positionals: string[];
  paths: string[];
  id?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  mcp: boolean;
  ttl?: string;
  exitCode: boolean;
  worktrees: boolean;
  untracked: boolean;
  ask: boolean;
  claude: boolean;
  strict: boolean;
  deep: boolean;
  overlap: boolean;
  semantic: boolean;
  neighbors: boolean;
  ignoreRegenerable: boolean;
  claim: boolean;
  all: boolean;
  oneline: boolean;
  statusline: boolean;
  stdin: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    positionals: [],
    paths: [],
    json: false,
    help: false,
    version: false,
    mcp: false,
    exitCode: false,
    worktrees: false,
    untracked: false,
    ask: false,
    claude: false,
    strict: false,
    deep: false,
    overlap: false,
    semantic: false,
    neighbors: false,
    ignoreRegenerable: false,
    claim: false,
    all: false,
    oneline: false,
    statusline: false,
    stdin: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name === 'paths') {
        i++;
        while (i < argv.length && !(argv[i] as string).startsWith('--')) {
          out.paths.push(argv[i] as string);
          i++;
        }
        continue;
      }
      if (name === 'json') out.json = true;
      else if (name === 'mcp') out.mcp = true;
      else if (name === 'exit-code') out.exitCode = true;
      else if (name === 'worktrees') out.worktrees = true;
      else if (name === 'untracked') out.untracked = true;
      else if (name === 'ask') out.ask = true;
      else if (name === 'claude') out.claude = true;
      else if (name === 'strict') out.strict = true;
      else if (name === 'deep') out.deep = true;
      else if (name === 'claim') out.claim = true;
      else if (name === 'all') out.all = true;
      else if (name === 'oneline') out.oneline = true;
      else if (name === 'statusline') out.statusline = true;
      else if (name === 'stdin') out.stdin = true;
      else if (name === 'overlap') out.overlap = true;
      else if (name === 'semantic') out.semantic = true;
      else if (name === 'neighbors') out.neighbors = true;
      else if (name === 'ignore-regenerable') out.ignoreRegenerable = true;
      else if (name === 'ttl') {
        i++;
        if (i >= argv.length) throw new Error('ceasefire: --ttl needs a value, e.g. --ttl 30m');
        out.ttl = argv[i] as string;
      }
      else if (name === 'help' || name === 'h') out.help = true;
      else if (name === 'version' || name === 'V') out.version = true;
      else if (name === 'id') {
        i++;
        if (i >= argv.length) throw new Error('ceasefire: --id needs a value');
        out.id = argv[i] as string;
      } else {
        throw new Error(`ceasefire: unknown flag --${name}`);
      }
    } else if (a === '-h') {
      out.help = true;
    } else if (a === '-V') {
      out.version = true;
    } else if (!out.command) {
      out.command = a;
    } else {
      out.positionals.push(a);
    }
    i++;
  }
  if (process.env.CEASEFIRE_JSON === '1') out.json = true;
  return out;
}

const HELP = `ceasefire ${VERSION} — parallel agents, zero merge fights.

Usage:
  ceasefire init [--claude [--strict] [--statusline]]
                                          install pre-push hook + GitHub workflow stub
                                          (--claude: also add the Claude Code hooks with auto-lease;
                                           --strict: hook denies collisions, onFailure "block";
                                           --statusline: show "ceasefire status --oneline" in Claude Code)
  ceasefire check <files...> [--json]     pre-edit collision check (paths may be absolute)
        [--claim]                         also hold the files (auto-lease) when you may proceed: for agents without the Claude hook
        [--stdin]                         read more file names from stdin, one per line (git diff --name-only | ceasefire check --stdin)
  ceasefire start "<task>" --paths <...>  publish an intent (advisory; paths or globs like 'src/**/*.ts')
        [--ttl 30m|2h|1d]                 intent lifetime (default 4h, 1m..7d)
  ceasefire done [--id <id> | --all]      complete your active intent (or all of them)
  ceasefire status [--oneline] [--json]   who is editing what right now (no network); --oneline fits a status line
  ceasefire list [--json]                 active intents, yours and other agents'
  ceasefire conflicts [--json]            collision matrix across branches + intents
        [--worktrees [--untracked]]       compare git worktrees incl. uncommitted edits
        [--deep]                          also find what merge-tree cannot: removed exports still used
                                          by the other branch (semantic) + same-file races (overlap)
        [--overlap|--semantic|--neighbors] pick individual deep checks (--neighbors = import-graph, noisy)
        [--exit-code [--ignore-regenerable]] exit 2 on any collision (lockfile-only ones optional)
  ceasefire suggest [files...] [--json]   unclaimed files to work on instead
  ceasefire doctor [--json]               check this machine is set up so agents warn each other
  ceasefire hook claude [--ask|--strict] [--claim]
                                          Claude Code PreToolUse hook (reads the event on stdin);
                                          --claim keeps a 15-minute sliding lease on every file the session edits
  ceasefire hook release                  Claude Code SessionEnd hook: free this session's leases
  ceasefire --mcp                         start MCP stdio server (ceasefire_check, ceasefire_conflicts)

Exit codes: 0 clear · 1 error · 2 advisory · 3 hard block (CEASEFIRE_STRICT=1)
Env: CEASEFIRE_JSON=1 · CEASEFIRE_STRICT=1 · CEASEFIRE_ALLOW_CONFLICT=1 · CEASEFIRE_AGENT=<name>
     CEASEFIRE_DIR=<store dir> · CEASEFIRE_SYNC=0 (disable git-refs broadcast)
`;

function fail(message: string): never {
  process.stderr.write(`ceasefire: error: ${message}\n`);
  process.exit(EXIT_ERROR);
}

async function main(): Promise<void> {
  // `ceasefire conflicts | head` closes the pipe early: that is not an error worth a stack trace.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw e;
  });
  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e instanceof Error ? e.message.replace(/^ceasefire: /, '') : String(e));
  }

  if (parsed.version) {
    process.stdout.write(`ceasefire ${VERSION}\n`);
    return;
  }
  if (parsed.mcp) {
    const { startStdio } = await import('../mcp/server.js');
    await startStdio();
    return;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!parsed.command) {
    process.stdout.write(HELP);
    process.exitCode = EXIT_ERROR;
    return;
  }

  const ctx: Ctx = { cwd: process.cwd(), json: parsed.json };

  switch (parsed.command) {
    case 'init': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire init [--claude]');
      if (parsed.strict && !parsed.claude) fail('--strict only applies to `ceasefire init --claude`');
      if (parsed.statusline && !parsed.claude) fail('--statusline only applies to `ceasefire init --claude`');
      return emit(cmdInit(ctx, { claude: parsed.claude, strict: parsed.strict, statusline: parsed.statusline }));
    }
    case 'check': {
      let files = parsed.positionals;
      if (parsed.stdin) {
        if (process.stdin.isTTY) fail('--stdin reads file names (one per line, or NUL-separated) from a pipe, e.g. `git diff --name-only | ceasefire check --stdin`');
        const input = await readStdin(MAX_STDIN_PATH_BYTES);
        if (input.overflow) fail('--stdin: more than 4MB of file names');
        files = [...files, ...input.text.split(input.text.includes('\0') ? '\0' : '\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '')];
      }
      return emit(cmdCheck(ctx, files, Date.now(), { claim: parsed.claim }));
    }
    case 'start': {
      const [task] = parsed.positionals;
      if (!task || parsed.positionals.length > 1) fail('usage: ceasefire start "<task>" --paths <file> [<file>...]');
      let ttlMs: number | undefined;
      if (parsed.ttl !== undefined) {
        const t = parseTtl(parsed.ttl);
        if (t === null) fail(`--ttl must look like 90s, 30m, 2h or 1d (1 minute to 7 days); got "${parsed.ttl.replace(/[^\x20-\x7e]/g, '?')}"`);
        ttlMs = t;
      }
      return emit(cmdStart(ctx, task as string, parsed.paths, ttlMs));
    }
    case 'done': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire done [--id <id>]');
      return emit(cmdDone(ctx, parsed.id, Date.now(), parsed.all));
    }
    case 'conflicts': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire conflicts [--json] [--worktrees [--untracked]] [--exit-code]');
      return emit(
        cmdConflicts(ctx, Date.now(), {
          exitCode: parsed.exitCode,
          worktrees: parsed.worktrees,
          untracked: parsed.untracked,
          overlap: parsed.deep || parsed.overlap,
          semantic: parsed.deep || parsed.semantic,
          neighbors: parsed.neighbors,
          ignoreRegenerable: parsed.ignoreRegenerable,
        }),
      );
    }
    case 'list': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire list [--json]');
      return emit(cmdList(ctx));
    }
    case 'hook': {
      const which = parsed.positionals[0];
      if (parsed.positionals.length !== 1 || (which !== 'claude' && which !== 'release')) fail('usage: ceasefire hook claude [--ask|--strict|--claim] | ceasefire hook release');
      if (process.stdin.isTTY) fail(`\`ceasefire hook ${which}\` reads a Claude Code hook event on stdin; it is meant to be run by Claude Code (see \`ceasefire init --claude\`).`);
      const input = await readStdin(MAX_HOOK_INPUT_BYTES);
      if (which === 'release') return emit(runReleaseHook(input.text));
      return emit(runClaudeHook(input.text, { ask: parsed.ask, strict: parsed.strict, claim: parsed.claim, overflow: input.overflow }));
    }
    case 'status': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire status [--oneline] [--json]');
      return emit(cmdStatus(ctx, { oneline: parsed.oneline }));
    }
    case 'doctor': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire doctor [--json]');
      return emit(cmdDoctor(ctx));
    }
    case 'suggest': {
      return emit(cmdSuggest(ctx, parsed.positionals));
    }
    default:
      fail(`unknown command "${parsed.command}". Run \`ceasefire --help\`.`);
  }
}

async function readStdin(limit: number): Promise<{ text: string; overflow: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) break;
    chunks.push(b);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), overflow: size > limit };
}

function emit(result: { exitCode: number; stdout: string; stderr?: string }): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
