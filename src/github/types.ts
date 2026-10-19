/**
 * Type surface for the GitHub integration.
 *
 * The canonical core types live in `src/types.ts` (owned by the core
 * worker) and are re-exported here. This module only adds
 * integration-specific types: `OpenPR` (a normalized pull request) and
 * `ClaimSignal` (a claimlock advisory signal).
 */
export type { Intent, Collision, Verdict, CollisionSeverity } from '../types.js';

export interface ClaimSignal {
  source: 'claimlock';
  claimId: string;
  path: string;
  holder: string;
  note: string;
  expiresInSec: number;
}

/** An open pull request, normalized from `gh` CLI or the GitHub REST API. */
export interface OpenPR {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  url: string;
  author: string;
  isDraft: boolean;
}
