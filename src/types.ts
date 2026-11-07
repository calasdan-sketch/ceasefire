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
 * - semantic: a removed export is still used by the other side's new code
 *   (confidence "high"), or the sides changed import neighbors ("low");
 *   produced by `ceasefire conflicts --deep` / `--neighbors`.
 * - overlap: both sides changed the same file and git merges it cleanly
 *   (`--overlap` / `--deep`).
 */
export type CollisionSeverity = 'textual' | 'intent' | 'semantic' | 'overlap';

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
  /** How sure a deep-forecast finding is. Absent for textual/intent findings. */
  confidence?: 'high' | 'low';
  /** Textual collision made only of lockfiles/generated files: regenerate, do not negotiate. */
  regenerable?: boolean;
  /** What to do for a regenerable collision. */
  hint?: string;
  /**
   * Intent collisions only: the side that should step aside. The earlier claim (then the lower id)
   * keeps priority; both agents compute the same answer, so they converge without negotiating.
   */
  yields?: string;
}

/** Verdict of `ceasefire check`. */
export type Verdict = 'clear' | 'advisory' | 'blocked';

/** Exit codes: 0 clear / 1 error / 2 advisory / 3 hard block. */
export const EXIT_CLEAR = 0;
export const EXIT_ERROR = 1;
export const EXIT_ADVISORY = 2;
export const EXIT_BLOCKED = 3;
