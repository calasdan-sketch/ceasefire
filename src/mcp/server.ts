/**
 * MCP stdio server for ceasefire, invoked via `ceasefire --mcp`.
 *
 * Exposes five tools, each a thin wrapper over the CLI:
 *   - `ceasefire_check`     (`ceasefire check --json <files>`)
 *   - `ceasefire_conflicts` (`ceasefire conflicts --json [--deep] [--worktrees]`)
 *   - `ceasefire_claim`     (`ceasefire start --json`: say what you are about to edit)
 *   - `ceasefire_release`   (`ceasefire done --all --json`)
 *   - `ceasefire_status`    (`ceasefire status --json`)
 *
 * The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) is loaded with
 * dynamic imports so `npm run build` stays green before the dependency is
 * installed (see DEPENDENCY note in the integration report). `buildServer`
 * takes the SDK as a parameter, so tests run against a fake.
 */
import { readFileSync } from 'node:fs';
import {
  CHECK_TOOL,
  CONFLICTS_TOOL,
  CLAIM_TOOL,
  RELEASE_TOOL,
  STATUS_TOOL,
  resolveCeasefireBin,
  runCheckTool,
  runConflictsTool,
  runClaimTool,
  runReleaseTool,
  runStatusTool,
  type CheckInput,
  type ConflictsInput,
  type ClaimInput,
  type McpToolResult,
  type CeasefireRunOptions,
} from './tools.js';

/** Minimal surface of the MCP SDK this server needs. */
export interface McpSdk {
  Server: new (info: { name: string; version: string }, caps: unknown) => {
    setRequestHandler(schema: { method: string }, handler: (request: unknown) => Promise<unknown>): void;
    connect(transport: unknown): Promise<void>;
  };
  StdioServerTransport: new () => unknown;
  ListToolsRequestSchema: { method: string };
  CallToolRequestSchema: { method: string };
}

/** Load the real SDK. Throws a helpful error when it is not installed. */
export async function loadSdk(): Promise<McpSdk> {
  const serverSpec: string = '@modelcontextprotocol/sdk/server/index.js';
  const stdioSpec: string = '@modelcontextprotocol/sdk/server/stdio.js';
  const typesSpec: string = '@modelcontextprotocol/sdk/types.js';
  try {
    const [serverMod, stdioMod, typesMod] = await Promise.all([
      import(serverSpec),
      import(stdioSpec),
      import(typesSpec),
    ]);
    return {
      Server: serverMod.Server as McpSdk['Server'],
      StdioServerTransport: stdioMod.StdioServerTransport as McpSdk['StdioServerTransport'],
      ListToolsRequestSchema: typesMod.ListToolsRequestSchema as { method: string },
      CallToolRequestSchema: typesMod.CallToolRequestSchema as { method: string },
    };
  } catch (err) {
    throw new Error(
      'The @modelcontextprotocol/sdk package is required for `ceasefire --mcp`: ' +
        'run `npm install @modelcontextprotocol/sdk`. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The package version, so the MCP handshake reports the real one (it used to say 0.1.0 forever). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ServerOptions {
  /** Ceasefire binary the tools shell out to. Defaults to resolveCeasefireBin(). */
  bin?: string;
  version?: string;
  /** Per-tool subprocess timeout. */
  timeoutMs?: number;
}

interface CallParams {
  params?: {
    name?: unknown;
    arguments?: unknown;
  };
}

/** Build (but do not connect) the MCP server. Exported for tests. */
export function buildServer(
  sdk: McpSdk,
  opts: ServerOptions = {},
): { connect(transport: unknown): Promise<void> } {
  const bin = opts.bin ?? resolveCeasefireBin();
  const runOpts: CeasefireRunOptions = {};
  if (opts.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
  const server = new sdk.Server(
    { name: 'ceasefire', version: opts.version ?? packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: [CHECK_TOOL, CONFLICTS_TOOL, CLAIM_TOOL, RELEASE_TOOL, STATUS_TOOL],
  }));

  server.setRequestHandler(sdk.CallToolRequestSchema, async (request: unknown) => {
    const params = (request as CallParams).params ?? {};
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    let result: McpToolResult;
    if (name === CHECK_TOOL.name) {
      const files = Array.isArray(args['files']) ? args['files'].filter((f): f is string => typeof f === 'string') : [];
      const checkInput: CheckInput = { files };
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;
      if (cwd !== undefined) checkInput.cwd = cwd;
      result = await runCheckTool(bin, checkInput, runOpts);
    } else if (name === CONFLICTS_TOOL.name) {
      const conflictsInput: ConflictsInput = {};
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;
      if (cwd !== undefined) conflictsInput.cwd = cwd;
      if (args['deep'] === true) conflictsInput.deep = true;
      if (args['worktrees'] === true) conflictsInput.worktrees = true;
      result = await runConflictsTool(bin, conflictsInput, runOpts);
    } else if (name === CLAIM_TOOL.name) {
      const paths = Array.isArray(args['paths']) ? args['paths'].filter((f): f is string => typeof f === 'string') : [];
      const claim: ClaimInput = { task: typeof args['task'] === 'string' ? args['task'] : '', paths };
      if (typeof args['ttl'] === 'string') claim.ttl = args['ttl'];
      if (typeof args['cwd'] === 'string') claim.cwd = args['cwd'];
      result = await runClaimTool(bin, claim, runOpts);
    } else if (name === RELEASE_TOOL.name || name === STATUS_TOOL.name) {
      const cwdInput = typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {};
      result = name === RELEASE_TOOL.name ? await runReleaseTool(bin, cwdInput, runOpts) : await runStatusTool(bin, cwdInput, runOpts);
    } else {
      result = {
        content: [{ type: 'text', text: `unknown tool: ${String(name)}` }],
        isError: true,
      };
    }
    return result;
  });

  return server;
}

/** Start the MCP server on stdio. Called by the CLI for `ceasefire --mcp`. */
export async function startStdio(opts: ServerOptions = {}): Promise<void> {
  const sdk = await loadSdk();
  const server = buildServer(sdk, opts);
  await server.connect(new sdk.StdioServerTransport());
}
