/** upsertCollisionComment: create or update the ceasefire PR comment idempotently. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertCollisionComment,
  githubCommentApi,
  type CommentApi,
} from '../../src/github/upsert.js';
import { COMMENT_MARKER } from '../../src/github/comment.js';

function fakeApi(comments: Array<{ id: number; body: string }>): CommentApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listComments: async () => { calls.push('list'); return comments; },
    createComment: async (body) => { calls.push(`create:${body.slice(0, 20)}`); },
    updateComment: async (id) => { calls.push(`update:${id}`); },
  };
}

test('creates a comment when none exists yet', async () => {
  const api = fakeApi([]);
  const result = await upsertCollisionComment(api, `hello\n${COMMENT_MARKER}`);
  assert.equal(result, 'created');
  assert.ok(api.calls.includes('list'));
  assert.ok(api.calls.some((c) => c.startsWith('create:')));
});

test('updates the existing ceasefire comment instead of posting a duplicate', async () => {
  const api = fakeApi([
    { id: 1, body: 'someone else' },
    { id: 2, body: `old forecast\n${COMMENT_MARKER}` },
  ]);
  const result = await upsertCollisionComment(api, `new\n${COMMENT_MARKER}`);
  assert.equal(result, 'updated');
  assert.ok(api.calls.includes('update:2'));
  assert.ok(!api.calls.some((c) => c.startsWith('create:')));
});

test('ignores other bots\u2019 comments without the marker', async () => {
  const api = fakeApi([{ id: 9, body: 'coverage: 80%' }]);
  const result = await upsertCollisionComment(api, `x\n${COMMENT_MARKER}`);
  assert.equal(result, 'created');
});

test('githubCommentApi builds a working REST client (mocked fetch)', async () => {
  const seen: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ method: init?.method ?? 'GET', url: String(url) });
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify([{ id: 5, body: `old\n${COMMENT_MARKER}` }]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const api = githubCommentApi('acme', 'repo', 42, 'tok', fetchImpl);
  const result = await upsertCollisionComment(api, `new\n${COMMENT_MARKER}`);
  assert.equal(result, 'updated');
  assert.ok(seen.some((s) => s.method === 'GET' && s.url.includes('/issues/42/comments')));
  assert.ok(seen.some((s) => s.method === 'PATCH' && s.url.includes('/comments/5')));
  const patch = seen.find((s) => s.method === 'PATCH');
  assert.ok(patch !== undefined);
});

test('create path POSTs to the issue comments endpoint', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if ((init?.method ?? 'GET') === 'GET') return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  });
  const api = githubCommentApi('acme', 'repo', 42, 'tok', fetchImpl);
  assert.equal(await upsertCollisionComment(api, `x\n${COMMENT_MARKER}`), 'created');
  assert.ok(seen.some((s) => s.startsWith('POST') && s.includes('/issues/42/comments')));
});

test('listComments follows Link pagination so the marker is found past page 1', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if ((init?.method ?? 'GET') !== 'GET') return new Response('{}', { status: 200 });
    if (String(url).includes('page=2')) {
      return new Response(JSON.stringify([{ id: 7, body: `old\n${COMMENT_MARKER}` }]), { status: 200 });
    }
    return new Response(JSON.stringify([{ id: 1, body: 'unrelated chatter' }]), {
      status: 200,
      headers: {
        link: '<https://api.github.com/repos/acme/repo/issues/42/comments?per_page=100&page=2>; rel="next"',
      },
    });
  });
  const api = githubCommentApi('acme', 'repo', 42, 'tok', fetchImpl);
  // Without pagination this would POST a duplicate; with it, it PATCHes id 7.
  assert.equal(await upsertCollisionComment(api, `new\n${COMMENT_MARKER}`), 'updated');
  const gets = seen.filter((s) => s.startsWith('GET'));
  assert.equal(gets.length, 2, `expected 2 comment pages, got: ${gets.join(' | ')}`);
  assert.ok(gets[1]?.includes('page=2'));
  assert.ok(seen.some((s) => s.startsWith('PATCH') && s.includes('/comments/7')));
});
