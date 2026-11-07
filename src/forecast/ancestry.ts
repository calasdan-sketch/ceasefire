/**
 * Which tips are ancestors of which other tips?
 *
 * If branch A's tip is an ancestor of (or equal to) branch B's tip, merging them is a
 * fast-forward: it can never conflict, and B already contains everything A did. Real
 * repositories are full of such pairs (merged-but-not-deleted branches, copies of main), and
 * the all-pairs forecast is quadratic, so dropping them first is an exact speed-up, not a
 * heuristic: 600 branches that all pointed at one commit took 23 s before, and take ~1 s now.
 *
 * One `git rev-list --parents` process lists every commit reachable from the tips; a
 * bitset per commit (one bit per distinct tip) is propagated from parents to children.
 * If the history is too large to hold, or git fails, the answer is "no pair is related",
 * which only means no pair is skipped.
 */
import { gitResult } from './git.js';

/** Above this many reachable commits the bitsets could cost hundreds of MB: skip the optimisation. */
export const MAX_ANCESTRY_COMMITS = 400_000;

export type Related = (oidA: string, oidB: string) => boolean;

const NOTHING_RELATED: Related = () => false;

export function relatedTips(cwd: string, tips: string[]): Related {
  const distinct = [...new Set(tips)];
  if (distinct.length < 2) return (a, b) => a === b;
  const index = new Map(distinct.map((o, i) => [o, i]));
  const r = gitResult(cwd, ['rev-list', '--parents', '--topo-order', '--stdin'], { input: distinct.join('\n') + '\n' });
  if (r.exitCode !== 0) return (a, b) => a === b;
  const lines = r.stdout.split('\n');
  if (lines.length > MAX_ANCESTRY_COMMITS) return (a, b) => a === b;
  const words = Math.ceil(distinct.length / 32);
  const reach = new Map<string, Uint32Array>();
  // rev-list prints children before parents; walk it backwards so parents are done first.
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k] as string;
    if (line === '') continue;
    const parts = line.split(' ');
    const bits = new Uint32Array(words);
    for (let p = 1; p < parts.length; p++) {
      const pr = reach.get(parts[p] as string);
      if (pr) for (let w = 0; w < words; w++) bits[w] = (bits[w] as number) | (pr[w] as number);
    }
    const tip = index.get(parts[0] as string);
    if (tip !== undefined) bits[tip >>> 5] = ((bits[tip >>> 5] as number) | (1 << (tip & 31))) >>> 0;
    reach.set(parts[0] as string, bits);
  }
  const has = (descendant: string, ancestor: string): boolean => {
    const bits = reach.get(descendant);
    const i = index.get(ancestor);
    if (!bits || i === undefined) return false;
    return (((bits[i >>> 5] as number) >>> (i & 31)) & 1) === 1;
  };
  return (a, b) => a === b || has(a, b) || has(b, a);
}

export { NOTHING_RELATED };
