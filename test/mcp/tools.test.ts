/** MCP tools: ceasefire_check / ceasefire_conflicts via the ceasefire CLI subprocess. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECK_TOOL,
  CONFLICTS_TOOL,
  invokeCeasefireJson,
  resolveCeasefireBin,
  runCheckTool,
  runConflictsTool,
} from '../../src/mcp/tools.js';
import { tempDir } from '../helpers.js';

/** A fake `ceasefire` bin: shell script echoing canned JSON with a chosen exit code. */
function fakeBin(stdout: string, exitCode = 0, recordArgsTo?: string): string {
  const dir = tempDir('ceasefire-bin-');
  const bin = join(dir, 'ceasefire');
  const record = recordArgsTo !== undefined ? `echo "$@" > ${recordArgsTo}\n` : '';
  writeFileSync(bin, `#!/bin/sh\n${record}printf '%s' '${stdout.replace(/'/g, `'\\''`)}'\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test('tool definitions carry names, descriptions, and JSON schemas', () => {
  assert.equal(CHECK_TOOL.name, 'ceasefire_check');
  assert.equal(CONFLICTS_TOOL.name, 'ceasefire_conflicts');
  assert.ok((CHECK_TOOL.description?.length ?? 0) > 20);
  const schema = CHECK_TOOL.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(schema.required.includes('files'));
  assert.ok('files' in schema.properties);
});

test('invokeCeasefireJson parses --json output and reports the exit code', async () => {
  const bin = fakeBin('{"verdict":"advisory","collisions":[]}');
  const res = await invokeCeasefireJson(bin, ['check', '--json', '--', 'a.ts'], { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.json, { verdict: 'advisory', collisions: [] });
  assert.equal(res.timedOut, false);
});

test('CLI arguments are forwarded verbatim (check --json -- <files>)', async () => {
  const dir = tempDir('ceasefire-args-');
  const record = join(dir, 'args.txt');
  const bin = fakeBin('{}', 0, record);
  await invokeCeasefireJson(bin, ['check', '--json', '--', 'a b.ts', 'c.ts'], { timeoutMs: 5000 });
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(record, 'utf8').trim(), 'check --json -- a b.ts c.ts');
});

test('a .js binary (like dist/cli.js, no shebang) is launched through node', async () => {
  const dir = tempDir('ceasefire-jsbin-');
  const bin = join(dir, 'cli.js');
  // NOTE: deliberately no shebang — mirrors tsc-compiled dist/cli.js
  writeFileSync(bin, `process.stdout.write(JSON.stringify({ verdict: 'clear' }));\n`);
  const res = await invokeCeasefireJson(bin, ['check', '--json'], { timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.json, { verdict: 'clear' });
});

test('non-JSON stdout surfaces as an error with the raw output attached', async () => {
  const bin = fakeBin('not json at all', 1);
  const res = await invokeCeasefireJson(bin, ['conflicts', '--json'], { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.error ?? '', /not json/);
});

test('missing binary reports a clear error instead of throwing', async () => {
  const res = await invokeCeasefireJson('/nonexistent/ceasefire', ['check'], { timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /spawn|ENOENT/i);
});

test('timeout kills the process and reports timedOut', async () => {
  const dir = tempDir('ceasefire-slow-');
  const bin = join(dir, 'ceasefire');
  writeFileSync(bin, '#!/bin/sh\nsleep 30\n');
  chmodSync(bin, 0o755);
  const res = await invokeCeasefireJson(bin, ['check'], { timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
});

test('resolveCeasefireBin: CEASEFIRE_BIN wins, then sibling CLI, then PATH fallback', async () => {
  const prev = process.env['CEASEFIRE_BIN'];
  try {
    process.env['CEASEFIRE_BIN'] = '/custom/ceasefire';
    assert.equal(resolveCeasefireBin(), '/custom/ceasefire');
    delete process.env['CEASEFIRE_BIN'];
    // In this build layout the sibling dist CLI exists next to tools.js.
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const toolsDir = dirname(fileURLToPath(new URL('../../src/mcp/tools.js', import.meta.url)));
    const sibling = join(toolsDir, '..', 'cli.js');
    const { existsSync } = await import('node:fs');
    assert.equal(resolveCeasefireBin(), existsSync(sibling) ? sibling : 'ceasefire');
  } finally {
    if (prev !== undefined) process.env['CEASEFIRE_BIN'] = prev;
  }
});

test('runCheckTool returns MCP content with the parsed verdict', async () => {
  const bin = fakeBin('{"verdict":"clear","collisions":[]}');
  const out = await runCheckTool(bin, { files: ['src/a.ts'] }, { timeoutMs: 5000 });
  assert.equal(out.isError, undefined);
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /clear/);
});

test('runCheckTool requires at least one file', async () => {
  const out = await runCheckTool('/nonexistent', { files: [] }, {});
  assert.equal(out.isError, true);
  assert.match((out.content[0] as { text: string }).text, /at least one file/i);
});

test('runConflictsTool forwards cwd and surfaces failures as MCP errors', async () => {
  const dir = tempDir('ceasefire-repo-');
  const bin = fakeBin('boom', 2);
  const out = await runConflictsTool(bin, { cwd: dir }, { timeoutMs: 5000 });
  assert.equal(out.isError, true);
  assert.match((out.content[0] as { text: string }).text, /boom/);
});

test('runConflictsTool success path returns formatted JSON text', async () => {
  const bin = fakeBin('{"verdict":"advisory","collisions":[{"a":1}]}');
  const out = await runConflictsTool(bin, {}, { timeoutMs: 5000 });
  // advisory (exit 2) is a successful check with findings, not a tool failure
  assert.equal(out.isError, undefined);
  const text = (out.content[0] as { text: string }).text;
  assert.match(text, /advisory/);
});
