/** MCP server wiring: builds a Server from the SDK, handlers delegate to tools.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, type McpSdk, type ServerOptions } from '../../src/mcp/server.js';

/** Minimal fake of the MCP SDK Server: records handlers, lets tests invoke them. */
function fakeSdk() {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
  const requests: unknown[] = [];
  class FakeServer {
    info: unknown;
    constructor(info: unknown) { this.info = info; }
    setRequestHandler(schema: { method: string }, handler: (req: unknown) => Promise<unknown>): void {
      handlers.set(schema.method, handler);
    }
    async connect(transport: unknown): Promise<void> { requests.push(transport); }
  }
  const sdk: McpSdk = {
    Server: FakeServer,
    StdioServerTransport: class { kind = 'stdio'; },
    ListToolsRequestSchema: { method: 'tools/list' },
    CallToolRequestSchema: { method: 'tools/call' },
  };
  return { sdk, handlers, requests };
}

const LIST = 'tools/list';
const CALL = 'tools/call';

test('server lists ceasefire_check and ceasefire_conflicts', async () => {
  const { sdk, handlers } = fakeSdk();
  const opts: ServerOptions = { bin: '/fake/ceasefire' };
  buildServer(sdk, opts);
  const list = handlers.get(LIST);
  assert.ok(list, 'list handler registered');
  const res = (await list({})) as { tools: Array<{ name: string }> };
  const names = res.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['ceasefire_check', 'ceasefire_conflicts']);
});

test('ceasefire_check call delegates to runCheckTool with the resolved bin', async () => {
  const { sdk, handlers } = fakeSdk();
  // point the server at a real `true`-like bin via CEASEFIRE_BIN is awkward here;
  // instead verify the call path by giving a bin that fails fast.
  buildServer(sdk, { bin: '/nonexistent/ceasefire-bin-xyz' });
  const call = handlers.get(CALL);
  assert.ok(call, 'call handler registered');
  const res = (await call({ params: { name: 'ceasefire_check', arguments: { files: ['a.ts'] } } })) as {
    isError?: boolean; content: Array<{ text: string }>;
  };
  assert.equal(res.isError, true);
  assert.match(res.content[0]?.text ?? '', /not found|CEASEFIRE_BIN/);
});

test('unknown tool name returns an MCP error', async () => {
  const { sdk, handlers } = fakeSdk();
  buildServer(sdk, { bin: '/nonexistent' });
  const call = handlers.get(CALL);
  assert.ok(call);
  const res = (await call({ params: { name: 'nope', arguments: {} } })) as { isError?: boolean };
  assert.equal(res.isError, true);
});

test('server info carries the ceasefire name and version', async () => {
  const { sdk } = fakeSdk();
  let seenInfo: unknown;
  const capturing: McpSdk = {
    ...sdk,
    Server: class {
      constructor(info: unknown) { seenInfo = info; }
      setRequestHandler(): void {}
      async connect(): Promise<void> {}
    },
  };
  buildServer(capturing, { bin: 'ceasefire', version: '9.9.9' });
  assert.deepEqual(seenInfo, { name: 'ceasefire', version: '9.9.9' });
});
