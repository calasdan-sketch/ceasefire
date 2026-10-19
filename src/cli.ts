#!/usr/bin/env node
/**
 * ceasefire — parallel agents, zero merge fights.
 *
 * Commands:
 *   ceasefire init                          install pre-push hook + workflow stub
 *   ceasefire check <files...> [--json]     pre-edit collision check (0 clear / 2 advisory / 3 block)
 *   ceasefire start "<task>" --paths <...>  publish an intent
 *   ceasefire done [--id <id>]              complete your active intent
 *   ceasefire conflicts [--json]            full collision matrix
 *   ceasefire suggest [files...] [--json]   productive alternative when blocked
 *
 * Env: CEASEFIRE_JSON=1 (force JSON), CEASEFIRE_STRICT=1 (advisory -> hard block),
 *      CEASEFIRE_ALLOW_CONFLICT=1 (proceed anyway), CEASEFIRE_DIR (store dir),
 *      CEASEFIRE_AGENT (identity), CEASEFIRE_SYNC=0 (disable git-refs broadcast).
 */
import { readFileSync } from 'node:fs';
import { cmdCheck, cmdConflicts, cmdDone, cmdInit, cmdStart, cmdSuggest, type Ctx } from './cli/commands.js';
import { EXIT_ERROR } from './types.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = version();

interface Parsed {
  command?: string;
  positionals: string[];
  paths: string[];
  id?: string;
  json: boolean;
  help: boolean;
  version: boolean;
  mcp: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], paths: [], json: false, help: false, version: false, mcp: false };
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
  ceasefire init                          install pre-push hook + GitHub workflow stub
  ceasefire check <files...> [--json]     pre-edit collision check
  ceasefire start "<task>" --paths <...>  publish an intent (advisory, 4h TTL)
  ceasefire done [--id <id>]              complete your active intent
  ceasefire conflicts [--json]            collision matrix across branches + intents
  ceasefire suggest [files...] [--json]   unclaimed files to work on instead
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
    const { startStdio } = await import('./mcp/server.js');
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
      if (parsed.positionals.length > 0) fail('usage: ceasefire init');
      return emit(cmdInit(ctx));
    }
    case 'check': {
      return emit(cmdCheck(ctx, parsed.positionals));
    }
    case 'start': {
      const [task] = parsed.positionals;
      if (!task || parsed.positionals.length > 1) fail('usage: ceasefire start "<task>" --paths <file> [<file>...]');
      return emit(cmdStart(ctx, task as string, parsed.paths));
    }
    case 'done': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire done [--id <id>]');
      return emit(cmdDone(ctx, parsed.id));
    }
    case 'conflicts': {
      if (parsed.positionals.length > 0) fail('usage: ceasefire conflicts [--json]');
      return emit(cmdConflicts(ctx));
    }
    case 'suggest': {
      return emit(cmdSuggest(ctx, parsed.positionals));
    }
    default:
      fail(`unknown command "${parsed.command}". Run \`ceasefire --help\`.`);
  }
}

function emit(result: { exitCode: number; stdout: string; stderr?: string }): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
