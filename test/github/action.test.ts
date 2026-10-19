/** Action entrypoint: env parsing, orchestration, exit codes. All I/O injected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAction,
  readActionEnv,
  resolveTriggerPrNumber,
  labelCollisions,
  type ActionDeps,
  type ActionEnv,
} from '../../src/github/action.js';
import { renderCollisionComment } from '../../src/github/comment.js';
import type { Collision, OpenPR } from '../../src/github/types.js';
import type { ExecFn } from '../../src/github/prs.js';
import type { CommentApi } from '../../src/github/upsert.js';

function pr(n: number, headRef = `feat/thing-${n}`): OpenPR {
  return {
    number: n, title: `T${n}`, headRef, headSha: `sha${n}`,
    baseRef: 'main', baseSha: 'b0', url: `https://github.com/acme/repo/pull/${n}`,
    author: 'dan', isDraft: false,
  };
}

function baseEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'acme/repo',
    GITHUB_WORKSPACE: '/repo',
    GITHUB_REF: 'refs/pull/42/merge',
    GITHUB_EVENT_NAME: 'pull_request',
    ...over,
  } as NodeJS.ProcessEnv;
}

function deps(over: Partial<ActionDeps> = {}): ActionDeps & { seen: Record<string, unknown[]> } {
  const seen: Record<string, unknown[]> = { outputs: [], logs: [], apis: [] };
  const execCalls: string[] = [];
  const exec: ExecFn = async (_cmd, args) => {
    execCalls.push(args.join(' '));
    return { stdout: '', stderr: '' };
  };
  seen['exec'] = execCalls;
  const bodies: string[] = [];
  seen['bodies'] = bodies;
  const api: CommentApi = {
    listComments: async () => [],
    createComment: async (body) => { bodies.push(body); },
    updateComment: async () => {},
  };
  const full: ActionDeps = {
    env: readActionEnv(baseEnv()),
    listPRs: async () => [pr(42), pr(43)],
    exec,
    forecastImpl: async () => [],
    loadIntents: async () => [],
    readSignals: () => [],
    commentApiFor: (n) => { (seen['apis'] as number[]).push(n); return api; },
    renderComment: renderCollisionComment,
    setOutput: (name, value) => { (seen['outputs'] as Array<[string, string]>).push([name, value]); },
    log: (msg) => { (seen['logs'] as string[]).push(msg); },
    ...over,
  };
  return Object.assign(full, { seen });
}

test('happy path: fetches PR heads, forecasts, upserts comment on the trigger PR', async () => {
  const d = deps();
  const result = await runAction(d);
  const execCalls = d.seen['exec'] as string[];
  assert.ok(execCalls.some((c) => c.includes('pull/42/head:ceasefire/pr/42')));
  assert.ok(execCalls.some((c) => c.includes('pull/43/head:ceasefire/pr/43')));
  assert.deepEqual(d.seen['apis'], [42]);
  assert.equal(result.commented, true);
  assert.equal(result.verdict, 'clear');
  assert.equal(result.exitCode, 0);
  const bodies = d.seen['bodies'] as string[];
  assert.equal(bodies.length, 1);
  assert.match(bodies[0] ?? '', /no collisions/i);
  const outputs = d.seen['outputs'] as Array<[string, string]>;
  assert.ok(outputs.some(([k, v]) => k === 'verdict' && v === 'clear'));
});

test('PR head fetches force-update so force-pushed PRs are not silently excluded', async () => {
  const d = deps();
  await runAction(d);
  const execCalls = d.seen['exec'] as string[];
  assert.ok(
    execCalls.some((c) => c.includes('+pull/42/head:ceasefire/pr/42')),
    `expected force refspec, got: ${execCalls.join(' | ')}`,
  );
});

test('fewer than two open PRs: no comment, clear verdict', async () => {
  const d = deps({ listPRs: async () => [pr(42)] });
  const result = await runAction(d);
  assert.equal(result.commented, false);
  assert.equal(result.verdict, 'clear');
  assert.deepEqual(d.seen['apis'], []);
});

test('branch tokens are labeled as #N headRef in the comment', async () => {
  const collisions: Collision[] = [
    { prA: 'ceasefire/pr/42', prB: 'ceasefire/pr/43', files: ['src/a.ts'], severity: 'textual' },
  ];
  const d = deps({ forecastImpl: async () => collisions });
  const result = await runAction(d);
  assert.equal(result.verdict, 'blocked');
  const bodies = d.seen['bodies'] as string[];
  assert.match(bodies[0] ?? '', /#42 `feat\/thing-42`/);
  assert.match(bodies[0] ?? '', /#43 `feat\/thing-43`/);
});

test('fail-on=block exits 1 on textual collisions; fail-on=never exits 0', async () => {
  const collisions: Collision[] = [
    { prA: 'ceasefire/pr/42', prB: 'ceasefire/pr/43', files: ['x'], severity: 'textual' },
  ];
  const strict = deps({
    env: readActionEnv(baseEnv({ INPUT_FAIL_ON: 'block' })),
    forecastImpl: async () => collisions,
  });
  assert.equal((await runAction(strict)).exitCode, 1);

  const advisoryOnly = deps({
    env: readActionEnv(baseEnv({ INPUT_FAIL_ON: 'never' })),
    forecastImpl: async () => collisions,
  });
  assert.equal((await runAction(advisoryOnly)).exitCode, 0);
});

test('fail-on=advisory exits 1 on intent collisions but 0 when clear', async () => {
  const collisions: Collision[] = [
    { prA: 'ceasefire/pr/42', prB: 'ceasefire/pr/43', files: ['x'], severity: 'intent' },
  ];
  const d = deps({
    env: readActionEnv(baseEnv({ INPUT_FAIL_ON: 'advisory' })),
    forecastImpl: async () => collisions,
  });
  assert.equal((await runAction(d)).exitCode, 1);
  const clear = deps({ env: readActionEnv(baseEnv({ INPUT_FAIL_ON: 'advisory' })) });
  assert.equal((await runAction(clear)).exitCode, 0);
});

test('unknown trigger PR: comment body goes to the log instead of the API', async () => {
  const d = deps({
    env: readActionEnv(baseEnv({ GITHUB_REF: 'refs/heads/main' })),
    forecastImpl: async () => [],
  });
  const result = await runAction(d);
  assert.equal(result.commented, false);
  assert.deepEqual(d.seen['apis'], []);
  const logs = d.seen['logs'] as string[];
  assert.ok(logs.some((l) => l.includes('no collisions') || l.includes('Ceasefire')));
});

test('a PR whose fetch fails is excluded from the forecast', async () => {
  const seenBranches: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    if (args.join(' ').includes('pull/43/head')) throw new Error('fetch failed');
    return { stdout: '', stderr: '' };
  };
  const d = deps({
    exec,
    listPRs: async () => [pr(42), pr(43), pr(44)],
    forecastImpl: async (_r, branches) => { seenBranches.push(branches); return []; },
  });
  await runAction(d);
  assert.deepEqual(seenBranches[0], ['ceasefire/pr/42', 'ceasefire/pr/44']);
});

test('readActionEnv throws on missing GITHUB_REPOSITORY', () => {
  assert.throws(() => readActionEnv(baseEnv({ GITHUB_REPOSITORY: undefined })), /GITHUB_REPOSITORY/);
});

test('readActionEnv throws on missing token', () => {
  assert.throws(() => readActionEnv(baseEnv({ GITHUB_TOKEN: undefined })), /token/i);
});

test('readActionEnv rejects an invalid fail-on value', () => {
  assert.throws(() => readActionEnv(baseEnv({ INPUT_FAIL_ON: 'sometimes' })), /fail-on/i);
});

test('resolveTriggerPrNumber: refs/pull/N/merge wins', () => {
  assert.equal(resolveTriggerPrNumber('refs/pull/42/merge', null), 42);
});

test('resolveTriggerPrNumber: falls back to the pull_request event payload', () => {
  const payload = JSON.stringify({ pull_request: { number: 43 } });
  assert.equal(resolveTriggerPrNumber('refs/heads/main', payload), 43);
});

test('resolveTriggerPrNumber: issue_comment payload with a PR issue', () => {
  const payload = JSON.stringify({ issue: { number: 44, pull_request: {} } });
  assert.equal(resolveTriggerPrNumber('refs/heads/main', payload), 44);
});

test('resolveTriggerPrNumber: null when nothing identifies a PR', () => {
  assert.equal(resolveTriggerPrNumber('refs/heads/main', null), null);
  assert.equal(resolveTriggerPrNumber('refs/heads/main', JSON.stringify({})), null);
});

test('labelCollisions leaves non-PR branch names untouched', () => {
  const out = labelCollisions(
    [{ prA: 'agent-a', prB: 'agent-b', files: [], severity: 'intent' }],
    [pr(42)],
  );
  assert.equal(out[0]?.prA, 'agent-a');
});

test('action env exposes run URL when GITHUB_RUN_ID is set', () => {
  const env: ActionEnv = readActionEnv(baseEnv({ GITHUB_RUN_ID: '123' }));
  assert.equal(env.runUrl, 'https://github.com/acme/repo/actions/runs/123');
});
