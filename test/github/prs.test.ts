/** listOpenPRs: `gh` CLI first, GitHub REST API fallback. All I/O injected. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOpenPRs, type ExecFn, type FetchFn } from '../../src/github/prs.js';

const OWNER = 'acme';
const REPO = 'repo';

function ghExec(stdout: string): ExecFn {
  return async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.ok(args.includes('pr'), 'expected a `gh pr` invocation');
    assert.ok(args.includes(`${OWNER}/${REPO}`), 'expected repo scoping via -R');
    return { stdout, stderr: '' };
  };
}

const GH_JSON = JSON.stringify([
  {
    number: 42,
    title: 'WCB form',
    headRefName: 'feat/wcb-form',
    headRefOid: 'aaa111',
    baseRefName: 'main',
    baseRefOid: 'bbb222',
    url: 'https://github.com/acme/repo/pull/42',
    author: { login: 'dan' },
    isDraft: false,
  },
  {
    number: 43,
    title: 'Uploads refactor',
    headRefName: 'refactor/uploads',
    headRefOid: 'ccc333',
    baseRefName: 'main',
    baseRefOid: 'bbb222',
    url: 'https://github.com/acme/repo/pull/43',
    author: { login: 'hermes' },
    isDraft: true,
  },
]);

const REST_JSON = JSON.stringify([
  {
    number: 7,
    title: 'Docs',
    head: { ref: 'docs/readme', sha: 'ddd444' },
    base: { ref: 'main', sha: 'bbb222' },
    html_url: 'https://github.com/acme/repo/pull/7',
    user: { login: 'jarvis' },
    draft: false,
  },
]);

test('parses `gh pr list --json` output', async () => {
  const prs = await listOpenPRs({ owner: OWNER, repo: REPO, exec: ghExec(GH_JSON) });
  assert.equal(prs.length, 2);
  assert.equal(prs[0]?.number, 42);
  assert.equal(prs[0]?.headRef, 'feat/wcb-form');
  assert.equal(prs[0]?.headSha, 'aaa111');
  assert.equal(prs[0]?.baseRef, 'main');
  assert.equal(prs[0]?.url, 'https://github.com/acme/repo/pull/42');
  assert.equal(prs[0]?.author, 'dan');
  assert.equal(prs[0]?.isDraft, false);
  assert.equal(prs[1]?.isDraft, true);
});

test('empty PR list yields an empty array, not an error', async () => {
  const prs = await listOpenPRs({ owner: OWNER, repo: REPO, exec: ghExec('[]') });
  assert.deepEqual(prs, []);
});

test('falls back to the REST API when `gh` is not installed', async () => {
  const enoent: ExecFn = async () => {
    const err = new Error('spawn gh ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  };
  const fetchImpl: FetchFn = async (url, init) => {
    assert.match(String(url), /api\.github\.com\/repos\/acme\/repo\/pulls/);
    assert.match(String(url), /state=open/);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tok123');
    return new Response(REST_JSON, { status: 200 });
  };
  const prs = await listOpenPRs({ owner: OWNER, repo: REPO, exec: enoent, fetchImpl, token: 'tok123' });
  assert.equal(prs.length, 1);
  assert.equal(prs[0]?.number, 7);
  assert.equal(prs[0]?.headRef, 'docs/readme');
  assert.equal(prs[0]?.headSha, 'ddd444');
  assert.equal(prs[0]?.author, 'jarvis');
});

test('falls back to REST when `gh` exits non-zero (e.g. not authed)', async () => {
  const failing: ExecFn = async () => {
    throw new Error('gh: authentication required');
  };
  const fetchImpl: FetchFn = async () => new Response(REST_JSON, { status: 200 });
  const prs = await listOpenPRs({ owner: OWNER, repo: REPO, exec: failing, fetchImpl, token: 'tok123' });
  assert.equal(prs.length, 1);
});

test('throws a clear error when both `gh` and the API fail', async () => {
  const failing: ExecFn = async () => { throw new Error('no gh'); };
  const badFetch: FetchFn = async () => new Response('rate limited', { status: 403 });
  await assert.rejects(
    () => listOpenPRs({ owner: OWNER, repo: REPO, exec: failing, fetchImpl: badFetch, token: 'tok123' }),
    /GitHub API|gh/i,
  );
});

test('REST fallback without a token throws a helpful error instead of burning rate limit', async () => {
  const enoent: ExecFn = async () => { throw new Error('spawn gh ENOENT'); };
  let fetched = false;
  const fetchImpl: FetchFn = async () => { fetched = true; return new Response('[]', { status: 200 }); };
  // Hermetic: a GITHUB_TOKEN in the developer's or CI's env must not leak in.
  const saved = process.env['GITHUB_TOKEN'];
  delete process.env['GITHUB_TOKEN'];
  try {
    await assert.rejects(
      () => listOpenPRs({ owner: OWNER, repo: REPO, exec: enoent, fetchImpl }),
      /token/i,
    );
  } finally {
    if (saved !== undefined) process.env['GITHUB_TOKEN'] = saved;
  }
  assert.equal(fetched, false);
});
