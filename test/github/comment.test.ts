/** PR comment renderer: human-readable collision matrix, not a wall of JSON. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCollisionComment,
  deriveVerdict,
  COMMENT_MARKER,
  type CommentInput,
} from '../../src/github/comment.js';
import type { Collision, OpenPR } from '../../src/github/types.js';

function pr(n: number, headRef = `feat/thing-${n}`): OpenPR {
  return {
    number: n,
    title: `Thing ${n}`,
    headRef,
    headSha: `sha${n}`,
    baseRef: 'main',
    baseSha: 'base0',
    url: `https://github.com/acme/repo/pull/${n}`,
    author: 'dan',
    isDraft: false,
  };
}

function collision(over: Partial<Collision> = {}): Collision {
  return {
    prA: '#42 `feat/wcb-form`',
    prB: '#43 `refactor/uploads`',
    files: ['src/uploads.ts'],
    severity: 'textual',
    ...over,
  };
}

function input(over: Partial<CommentInput> = {}): CommentInput {
  return { prs: [pr(42), pr(43)], collisions: [], verdict: 'clear', ...over };
}

test('clear verdict renders a reassuring summary, not an empty table', () => {
  const body = renderCollisionComment(input({ verdict: 'clear' }));
  assert.match(body, /clear/i);
  assert.match(body, /no collisions/i);
  assert.doesNotMatch(body, /\|.*\|.*\|/); // no markdown table when clear
});

test('advisory verdict lists collisions in a markdown table', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'advisory',
      collisions: [collision({ severity: 'intent', files: ['src/auth/'] })],
    }),
  );
  assert.match(body, /advisory/i);
  assert.match(body, /\|/); // table present
  assert.match(body, /src\/auth\//);
});

test('blocked verdict is explicit about textual conflicts', () => {
  const body = renderCollisionComment(input({ verdict: 'blocked', collisions: [collision()] }));
  assert.match(body, /block/i);
  assert.match(body, /merge conflict/i);
});

test('collisions sort textual first, then intent, then semantic', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'blocked',
      collisions: [
        collision({ severity: 'semantic', files: ['s.ts'] }),
        collision({ severity: 'intent', files: ['i.ts'] }),
        collision({ severity: 'textual', files: ['t.ts'] }),
      ],
    }),
  );
  const t = body.indexOf('t.ts');
  const i = body.indexOf('i.ts');
  const s = body.indexOf('s.ts');
  assert.ok(t < i && i < s, 'expected textual < intent < semantic order');
});

test('severity sections explain what each level means and what to do', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'blocked',
      collisions: [
        collision({ severity: 'textual' }),
        collision({ severity: 'intent', files: ['i.ts'] }),
        collision({ severity: 'semantic', files: ['s.ts'] }),
      ],
    }),
  );
  assert.match(body, /what this means/i);
  assert.match(body, /next step|what to do/i);
});

test('branch names with pipes cannot break the table structure', () => {
  const nasty = pr(42, 'feat/a|b');
  const body = renderCollisionComment(
    input({
      prs: [nasty, pr(43)],
      verdict: 'advisory',
      collisions: [collision({ prA: '#42 `feat/a|b`', severity: 'intent', files: [] })],
    }),
  );
  // every table row must have exactly 4 cells (3 delimiters not counting escaped pipes)
  for (const line of body.split('\n')) {
    if (line.startsWith('|')) {
      const delimiters = line.replace(/\\\|/g, '').split('|').length - 1;
      assert.equal(delimiters, 4, `row has wrong cell count: ${line}`);
    }
  }
  assert.ok(body.includes('feat/a\\|b'), 'raw pipe must be escaped in table cells');
});

test('comment carries the idempotency marker for upserts', () => {
  const body = renderCollisionComment(input());
  assert.ok(body.includes(COMMENT_MARKER));
});

test('agent-supplied brackets cannot inject markdown links into the comment', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'advisory',
      collisions: [collision({ prA: '#1 `[x](http://evil.test)`', files: [] })],
    }),
  );
  assert.ok(!body.includes('[x](http://evil.test)'), 'raw markdown link survived escaping');
});

test('very long claim notes are truncated', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'clear',
      claimSignals: [
        {
          source: 'claimlock',
          claimId: 'c',
          path: 'src/a.ts',
          holder: 'hermes',
          note: 'n'.repeat(500),
          expiresInSec: 60,
        },
      ],
    }),
  );
  assert.ok(!body.includes('n'.repeat(500)), 'full 500-char note rendered');
  assert.ok(body.includes('n'.repeat(200)), 'truncated note still present');
});

test('re-run instructions are present', () => {
  const body = renderCollisionComment(input({ verdict: 'advisory', collisions: [collision()] }));
  assert.match(body, /re-run/i);
  assert.match(body, /\/ceasefire rerun/);
});

test('claimlock signals render as a heads-up section, not a verdict', () => {
  const body = renderCollisionComment(
    input({
      verdict: 'clear',
      claimSignals: [
        { source: 'claimlock', claimId: 'abc', path: 'src/uploads.ts', holder: 'hermes', note: 'wip', expiresInSec: 600 },
      ],
    }),
  );
  assert.match(body, /claim/i);
  assert.match(body, /hermes/);
  assert.match(body, /advisory|heads-up/i);
});

test('empty file lists render gracefully', () => {
  const body = renderCollisionComment(
    input({ verdict: 'advisory', collisions: [collision({ files: [] })] }),
  );
  assert.match(body, /no file list|—/);
});

test('deriveVerdict: no collisions -> clear', () => {
  assert.equal(deriveVerdict([]), 'clear');
});

test('deriveVerdict: textual -> block, intent/semantic only -> advisory', () => {
  assert.equal(deriveVerdict([collision({ severity: 'textual' })]), 'blocked');
  assert.equal(deriveVerdict([collision({ severity: 'intent' })]), 'advisory');
  assert.equal(deriveVerdict([collision({ severity: 'semantic' })]), 'advisory');
  assert.equal(
    deriveVerdict([collision({ severity: 'intent' }), collision({ severity: 'textual' })]),
    'blocked',
  );
});

test('draft PRs are labeled in the summary', () => {
  const draft = { ...pr(44), isDraft: true };
  const body = renderCollisionComment(
    input({
      prs: [pr(42), draft],
      verdict: 'advisory',
      collisions: [collision({ prA: '#42 `a`', prB: '#44 `b`', severity: 'intent', files: ['x'] })],
    }),
  );
  assert.match(body, /draft/i);
});
