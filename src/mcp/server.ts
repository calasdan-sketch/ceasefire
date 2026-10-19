/**
 * MCP stdio server for ceasefire, invoked via `ceasefire --mcp`.
 *
 * Exposes two tools:
 *   - `ceasefire_check`     (mirrors `ceasefire check --json <files>`)
 *   - `ceasefire_conflicts` (mirrors `ceasefire conflicts --json`)
 *
 * The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) is loaded with
 * dynamic imports so `npm run build` stays green before the dependency is
 * installed (see DEPENDENCY note in the integration report). `buildServer`
 * takes the SDK as a parameter, so tests run against a fake.
 */
import {
  CHECK_TOOL,
  CONFLICTS_TOOL,
  resolveCeasefireBin,
  runCheckTool,
  runConflictsTool,
  type CheckInput,
  type ConflictsInput,
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
    { name: 'ceasefire', version: opts.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: [CHECK_TOOL, CONFLICTS_TOOL],
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
      result = await runConflictsTool(bin, conflictsInput, runOpts);
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
