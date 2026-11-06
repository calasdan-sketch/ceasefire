/** Claude Code PreToolUse hook, init --claude, list, --ttl, absolute paths, sanitization, quiet stderr. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeRepo, tempDir } from './helpers.js';
import { installClaudeHook, CLAUDE_HOOK_COMMAND } from '../src/cli/commands.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.js');

function run(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string }) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'test-agent', ...opts.env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: opts.input ?? '',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function setup() {
  const repo = makeRepo();
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-hook-store-') };
  const r = run(['start', 'auth refactor', '--paths', 'src/auth/'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  assert.equal(r.code, 0, r.stderr);
  return { repo, env };
}

const event = (repo: string, tool: string, file: string) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', cwd: repo, tool_name: tool, tool_input: { file_path: file, content: 'x' } });

test('hook: clear edit -> no output, exit 0', () => {
  const { repo, env } = setup();
  const r = run(['hook', 'claude'], { cwd: repo, env, input: event(repo, 'Write', join(repo, 'other.txt')) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('hook: absolute path inside a held directory -> advisory additionalContext', () => {
  const { repo, env } = setup();
  const r = run(['hook', 'claude'], { cwd: repo, env, input: event(repo, 'Edit', join(repo, 'src', 'auth', 'login.ts')) });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'advisory never interrupts');
  assert.match(out.hookSpecificOutput.additionalContext, /hermes/);
});

test('hook: --ask asks, CEASEFIRE_STRICT=1 denies', () => {
  const { repo, env } = setup();
  const input = event(repo, 'Write', join(repo, 'src', 'auth', 'login.ts'));
  const ask = JSON.parse(run(['hook', 'claude', '--ask'], { cwd: repo, env, input }).stdout);
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
  const deny = JSON.parse(run(['hook', 'claude'], { cwd: repo, env: { ...env, CEASEFIRE_STRICT: '1' }, input }).stdout);
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /hermes/);
});

test('hook: non-file tools and files outside the repo are ignored', () => {
  const { repo, env } = setup();
  assert.equal(run(['hook', 'claude'], { cwd: repo, env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }) }).stdout, '');
  const r = run(['hook', 'claude'], { cwd: repo, env, input: event(repo, 'Write', '/tmp/elsewhere.txt') });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('hook: malformed input is a visible error, and fails closed in strict mode', () => {
  const { repo, env } = setup();
  const loose = run(['hook', 'claude'], { cwd: repo, env, input: 'not json' });
  assert.equal(loose.code, 1);
  assert.match(loose.stderr, /not a JSON/);
  const strict = run(['hook', 'claude'], { cwd: repo, env: { ...env, CEASEFIRE_STRICT: '1' }, input: '{"tool_name":"Write","tool_input":{}}' });
  assert.equal(strict.code, 0);
  assert.equal(JSON.parse(strict.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('init --claude merges into existing settings without clobbering and is idempotent', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'keep-me', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }));
  assert.equal(installClaudeHook(repo).ok, true);
  assert.equal(installClaudeHook(repo).ok, true);
  const s = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.model, 'keep-me');
  assert.equal(s.hooks.PreToolUse.length, 2, 'existing hook kept, ours added once');
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, CLAUDE_HOOK_COMMAND);
});

test('init --claude refuses to touch an unparseable settings file', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude', 'settings.json'), '{ broken');
  const r = installClaudeHook(repo);
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'), '{ broken');
});

test('check from a subdirectory and with an absolute path hits the same claim', () => {
  const { repo, env } = setup();
  const sub = run(['check', 'login.ts'], { cwd: join(repo, 'src', 'auth'), env });
  assert.equal(sub.code, 2, 'cwd-relative path resolved against the repo');
  const abs = run(['check', join(repo, 'src', 'auth', 'login.ts')], { cwd: repo, env });
  assert.equal(abs.code, 2);
  const out = run(['check', '../outside.ts'], { cwd: repo, env });
  assert.equal(out.code, 1);
  assert.match(out.stderr, /outside the repository/);
});

test('glob claims block matching files only', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-glob-store-') };
  run(['start', 'tests', '--paths', 'src/**/*.test.ts'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'hermes' } });
  assert.equal(run(['check', 'src/a/b.test.ts'], { cwd: repo, env }).code, 2);
  assert.equal(run(['check', 'src/a/b.ts'], { cwd: repo, env }).code, 0);
});

test('list shows active intents; --ttl sets the lifetime; bad --ttl is rejected', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-list-store-') };
  assert.match(run(['list'], { cwd: repo, env }).stdout, /no active intents/);
  assert.equal(run(['start', 'quick fix', '--paths', 'file.txt', '--ttl', '30m'], { cwd: repo, env }).code, 0);
  const listed = JSON.parse(run(['list', '--json'], { cwd: repo, env }).stdout);
  assert.equal(listed.intents.length, 1);
  const life = listed.intents[0].expiresAt - listed.intents[0].createdAt;
  assert.equal(life, 30 * 60_000);
  assert.match(run(['list'], { cwd: repo, env }).stdout, /"test-agent" \(you\)/);
  const bad = run(['start', 'x', '--paths', 'file.txt', '--ttl', '99y'], { cwd: repo, env });
  assert.equal(bad.code, 1);
});

test('suggest and list escape hostile agent/task text', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-esc-store-') };
  run(['start', 'evil‮task\x1b]52;c;AAAA\x07', '--paths', 'file.txt'], { cwd: repo, env: { ...env, CEASEFIRE_AGENT: 'herm​es' } });
  for (const args of [['suggest', 'file.txt'], ['list']]) {
    const r = run(args, { cwd: repo, env });
    assert.ok(!/[\x1b\x07‮​]/.test(r.stdout), `${args[0]} output is escaped`);
    assert.match(r.stdout, /herm<U\+200B>es/);
  }
});

test('the node:sqlite ExperimentalWarning never reaches stderr', () => {
  const repo = makeRepo();
  const r = run(['check', 'file.txt'], { cwd: repo, env: { CEASEFIRE_DIR: tempDir('ceasefire-warn-store-') } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning|SQLite/);
});

test('absurdly long paths are rejected, not stored', () => {
  const repo = makeRepo();
  const env = { CEASEFIRE_DIR: tempDir('ceasefire-long-store-') };
  const r = run(['start', 'x', '--paths', 'a/'.repeat(3000)], { cwd: repo, env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /longer than/);
});
