/**
 * Seam between the GitHub Action and core's merge-tree forecast.
 *
 * Core owns the forecast (`src/forecast/forecast.ts`, exporting
 * `buildCollisionMatrix(repo, branches, intents, now)` — see
 * test/forecast.test.ts). This module loads it with a dynamic import so the
 * Action degrades to a clear error (instead of a build break) if core has
 * not landed yet, and so tests can inject a fake.
 */
import type { Collision, Intent } from './types.js';
import { sanitizeDisplay } from '../cli/format.js';

export type ForecastImpl = (
  repoDir: string,
  branches: string[],
  intents: Intent[],
  now: number,
) => Promise<Collision[]>;

const CORE_SPEC: string = '../forecast/forecast.js';

/** Load core's `buildCollisionMatrix` via dynamic import. Exported for tests. */
export async function loadCoreForecast(spec: string = CORE_SPEC): Promise<ForecastImpl> {
  let mod: unknown;
  try {
    mod = await import(spec);
  } catch (err) {
    throw new Error(
      `ceasefire core forecast module not available (tried ${spec}): ` +
        'build the ceasefire package first so src/forecast/forecast.ts is compiled. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const fn = (mod as { buildCollisionMatrix?: unknown }).buildCollisionMatrix;
  if (typeof fn !== 'function') {
    throw new Error(
      `ceasefire core forecast module at ${spec} does not export buildCollisionMatrix(repo, branches, intents, now).`,
    );
  }
  const core = fn as (repo: string, branches: string[], intents: Intent[], now: number, onSkip?: (a: string, b: string, why: string) => void) => Collision[] | Promise<Collision[]>;
  // A pair the forecast cannot look at must be visible in the workflow log, never silently "clear".
  // Names come from other people's branches: control characters are removed so they cannot forge a workflow command.
  return async (repo, branches, intents, now) =>
    core(repo, branches, intents, now, (a, b, why) => {
      console.log(`::warning title=ceasefire::could not forecast ${sanitizeDisplay(a)} <-> ${sanitizeDisplay(b)}: ${sanitizeDisplay(why)}`);
    });
}

/** Run the forecast over local branch names. `impl` is injectable for tests. */
export async function forecastBranches(
  repoDir: string,
  branches: string[],
  intents: Intent[],
  now: number = Date.now(),
  impl?: ForecastImpl,
): Promise<Collision[]> {
  const run = impl ?? (await loadCoreForecast());
  return run(repoDir, branches, intents, now);
}
