/**
 * Read-only adapter for claimlock (shortleash fleet mode) path claims.
 *
 * Claimlock keeps agent path claims in a SQLite database (default
 * `~/.shortleash/fleet.db`, table `claims`: claim_id, path, owner, note,
 * expires_at, created_at — unix seconds). Ceasefire surfaces active claims as
 * *advisory* signals in forecasts: a claim is a heads-up that another agent
 * holds a path, never a block.
 *
 * This module NEVER writes: the database is opened read-only and expired
 * rows are filtered in SQL (claimlock itself prunes on write; we must not).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, basename, isAbsolute } from 'node:path';

export interface ClaimlockClaim {
  claimId: string;
  path: string;
  owner: string;
  note: string;
  expiresAt: number; // unix seconds
  createdAt: number; // unix seconds
}

export interface ClaimSignal {
  source: 'claimlock';
  claimId: string;
  path: string;
  holder: string;
  note: string;
  expiresInSec: number;
}

/** Default claimlock database location. `CLAIMLOCK_DB` overrides it. */
export function defaultClaimDbPath(): string {
  const override = process.env['CLAIMLOCK_DB'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.shortleash', 'fleet.db');
}

interface ClaimRow {
  claim_id: string;
  path: string;
  owner: string;
  note: string;
  expires_at: number;
  created_at: number;
}

/**
 * Read active (unexpired) claims. Returns [] when claimlock is not in use,
 * the database is missing, locked, or corrupt — claims are advisory, so a
 * read failure must never fail a forecast.
 */
export function readActiveClaims(
  dbPath: string = defaultClaimDbPath(),
  nowSec: number = Math.floor(Date.now() / 1000),
): ClaimlockClaim[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT claim_id, path, owner, note, expires_at, created_at
         FROM claims WHERE expires_at > ? ORDER BY created_at`,
      )
      .all(nowSec) as unknown as ClaimRow[];
    return rows.map((r) => ({
      claimId: r.claim_id,
      path: r.path,
      owner: r.owner ?? '',
      note: r.note ?? '',
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Claimlock's own overlap rule: equal paths, or one is a directory prefix of the other. */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Find claims overlapping any of `paths`. Paths are resolved the same way
 * claimlock normalizes them (absolute). First matching claim wins per path.
 */
export function claimsForPaths(
  claims: ClaimlockClaim[],
  paths: string[],
): Array<{ path: string; claim: ClaimlockClaim }> {
  const hits: Array<{ path: string; claim: ClaimlockClaim }> = [];
  for (const raw of paths) {
    const path = resolve(raw);
    const claim = claims.find((c) => overlaps(path, c.path));
    if (claim !== undefined) hits.push({ path, claim });
  }
  return hits;
}

/**
 * Map claims to advisory signals suitable for forecasts and PR comments.
 *
 * Claimlock stores absolute paths (`/home/<user>/…`). Rendering those raw
 * into a PR comment would leak the agent machine's directory layout
 * (including the username) to everyone who can read the PR. When
 * `baseDir` is given, paths under it are shown repo-relative; anything
 * else is reduced to its basename — enough for an advisory heads-up,
 * without the leak.
 */
export function toClaimSignals(
  claims: ClaimlockClaim[],
  nowSec: number = Math.floor(Date.now() / 1000),
  baseDir?: string,
): ClaimSignal[] {
  return claims.map((c) => ({
    source: 'claimlock' as const,
    claimId: c.claimId,
    path: displayPath(c.path, baseDir),
    holder: c.owner,
    note: c.note,
    expiresInSec: Math.max(0, c.expiresAt - nowSec),
  }));
}

/** Repo-relative when possible, basename otherwise — never a raw homedir path. */
function displayPath(path: string, baseDir?: string): string {
  if (baseDir !== undefined && baseDir !== '' && isAbsolute(path)) {
    const rel = relative(resolve(baseDir), path);
    if (rel !== '' && !rel.startsWith('..')) return rel;
    return basename(path);
  }
  return path;
}
