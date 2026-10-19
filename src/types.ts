/**
 * Shared types for ceasefire core.
 *
 * An Intent is a soft, expiring, advisory declaration by an agent that it is
 * about to work on a set of paths. Intents never block; they only inform.
 */

/** A published merge intent. */
export interface Intent {
  id: string;
  /** Agent identity, e.g. "hermes", "jarvis". */
  agent: string;
  /** Human-readable description of the work, e.g. "refactor login flow". */
  task: string;
  /** Git branch the agent is working on. */
  branch: string;
  /** Paths (files or directories, repo-relative) the agent intends to touch. */
  paths: string[];
  /** Unix epoch ms when the intent was published. */
  createdAt: number;
  /** Unix epoch ms when the intent lapses if not completed. */
  expiresAt: number;
  status: 'active' | 'done' | 'expired';
}

/**
 * Collision severity.
 * - textual: git merge-tree found conflicting hunks between two branches.
 * - intent: two active intents claim overlapping paths (advisory only).
 * - semantic: reserved for the v1.1 post-merge verifier (import collisions,
 *   duplicate symbols). No v1 producer emits this severity.
 */
export type CollisionSeverity = 'textual' | 'intent' | 'semantic';

/** One pairwise collision in the forecast matrix. */
export interface Collision {
  /** First side: branch name for textual, "agent/branch (id)" for intent. */
  prA: string;
  /** Second side, same labeling as prA. */
  prB: string;
  /** Repo-relative paths in contention. */
  files: string[];
  severity: CollisionSeverity;
  /** Extra context, e.g. the intent task that holds the files. */
  detail?: string;
}

/** Verdict of `ceasefire check`. */
export type Verdict = 'clear' | 'advisory' | 'blocked';

/** Exit codes: 0 clear / 1 error / 2 advisory / 3 hard block. */
export const EXIT_CLEAR = 0;
export const EXIT_ERROR = 1;
export const EXIT_ADVISORY = 2;
export const EXIT_BLOCKED = 3;
