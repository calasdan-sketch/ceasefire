/** forecastBranches: seam between the Action and core's merge-tree forecast. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forecastBranches,
  loadCoreForecast,
  type ForecastImpl,
} from '../../src/github/forecast.js';
import type { Collision, Intent } from '../../src/github/types.js';

const NOW = 1_800_000_000_000;

function fakeImpl(collisions: Collision[]): ForecastImpl {
  return async (repoDir, branches, intents, now) => {
    assert.equal(repoDir, '/repo');
    assert.deepEqual(branches, ['pr-42', 'pr-43']);
    assert.equal(intents.length, 1);
    assert.equal(now, NOW);
    return collisions;
  };
}

function intent(): Intent {
  return {
    id: 'i1', agent: 'hermes', task: 't', branch: 'b',
    paths: ['a.ts'], createdAt: NOW - 1, expiresAt: NOW + 1, status: 'active',
  };
}

test('delegates to the injected implementation with repo, branches, intents, now', async () => {
  const collisions: Collision[] = [{ prA: 'a', prB: 'b', files: ['f.ts'], severity: 'textual' }];
  const got = await forecastBranches('/repo', ['pr-42', 'pr-43'], [intent()], NOW, fakeImpl(collisions));
  assert.deepEqual(got, collisions);
});

test('loadCoreForecast throws a helpful error when core is not built', async () => {
  await assert.rejects(
    () => loadCoreForecast('definitely/not/a/real/module.js'),
    /core.*forecast|forecast.*core/i,
  );
});

test('loadCoreForecast rejects a module without buildCollisionMatrix', async () => {
  // node:test itself is a real module with no buildCollisionMatrix export
  await assert.rejects(() => loadCoreForecast('node:test'), /buildCollisionMatrix/);
});
