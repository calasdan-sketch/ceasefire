/**
 * GitHub Action entrypoint: forecast collisions across all open PRs and post
 * the collision matrix as a PR comment.
 *
 * Runs on `pull_request` (and `issue_comment` for `/ceasefire rerun`):
 *   1. list open PRs (`gh` CLI, REST fallback)
 *   2. fetch each PR head into a local branch `ceasefire/pr/<n>`
 *   3. run core's merge-tree forecast across all pairs
 *   4. render a human-readable collision matrix comment
 *   5. upsert the comment on the triggering PR (idempotent)
 *
 * Advisory by default: the workflow only fails when `fail-on` says so.
 * Compiles to `dist/src/github/action.js` — see `action.yml`.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultExec, listOpenPRs, type ExecFn } from './prs.js';
import { forecastBranches, type ForecastImpl } from './forecast.js';
import { deriveVerdict, renderCollisionComment, type CommentInput } from './comment.js';
import { githubCommentApi, upsertCollisionComment, type CommentApi } from './upsert.js';
import { readActiveClaims, toClaimSignals } from '../claimlock/adapter.js';
import type { ClaimSignal, Collision, Intent, OpenPR, Verdict } from './types.js';

export type FailOn = 'never' | 'advisory' | 'block';

export interface ActionEnv {
  token: string;
  owner: string;
  repo: string;
  repoFullName: string;
  workspace: string;
  eventName: string;
  prNumber: number | null;
  triggerHeadSha: string | null;
  runUrl: string | null;
  failOn: FailOn;
}

const PR_REF_RE = /^refs\/pull\/(\d+)\/(merge|head)$/;

/** Identify the triggering PR from the git ref or the event payload. Exported for tests. */
export function resolveTriggerPrNumber(
  githubRef: string | undefined,
  eventPayloadJson: string | null,
): number | null {
  if (githubRef !== undefined) {
    const m = PR_REF_RE.exec(githubRef);
    if (m?.[1] !== undefined) return parseInt(m[1], 10);
  }
  if (eventPayloadJson !== null) {
    try {
      const payload = JSON.parse(eventPayloadJson) as {
        pull_request?: { number?: unknown };
        issue?: { number?: unknown; pull_request?: unknown };
      };
      if (typeof payload.pull_request?.number === 'number') return payload.pull_request.number;
      if (typeof payload.issue?.number === 'number' && payload.issue.pull_request !== undefined) {
        return payload.issue.number;
      }
    } catch {
      // malformed payload — fall through to null
    }
  }
  return null;
}

export function readActionEnv(env: NodeJS.ProcessEnv, eventPayloadJson: string | null = null): ActionEnv {
  const token = env['INPUT_GITHUB_TOKEN'] ?? env['GITHUB_TOKEN'] ?? '';
  if (token === '') {
    throw new Error('GitHub token missing: set the `github-token` action input.');
  }
  const repoFullName = env['GITHUB_REPOSITORY'] ?? '';
  const parts = repoFullName.split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || owner === '' || repo === undefined || repo === '') {
    throw new Error(`GITHUB_REPOSITORY must be "owner/repo", got "${repoFullName}".`);
  }
  const failRaw = (env['INPUT_FAIL-ON'] ?? env['INPUT_FAIL_ON'] ?? 'never').toLowerCase();
  if (failRaw !== 'never' && failRaw !== 'advisory' && failRaw !== 'block') {
    throw new Error(`Invalid fail-on value "${failRaw}": expected one of never|advisory|block.`);
  }
  const runId = env['GITHUB_RUN_ID'];
  return {
    token,
    owner,
    repo,
    repoFullName,
    workspace: env['GITHUB_WORKSPACE'] ?? '.',
    eventName: env['GITHUB_EVENT_NAME'] ?? '',
    prNumber: resolveTriggerPrNumber(env['GITHUB_REF'], eventPayloadJson),
    triggerHeadSha: null, // resolved after PRs are listed
    runUrl: runId !== undefined && runId !== '' ? `https://github.com/${repoFullName}/actions/runs/${runId}` : null,
    failOn: failRaw,
  };
}

const PR_BRANCH_RE = /^ceasefire\/pr\/(\d+)$/;

/**
 * Replace forecast branch tokens (`ceasefire/pr/42`) with readable PR labels
 * (`#42 `+"`feat/wcb-form`"). Non-PR branch names pass through untouched.
 */
export function labelCollisions(collisions: Collision[], prs: OpenPR[]): Collision[] {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const label = (s: string): string => {
    const m = PR_BRANCH_RE.exec(s);
    const num = m?.[1];
    if (num === undefined) return s;
    const pr = byNumber.get(parseInt(num, 10));
    // Sanitize the branch name once, here, so the renderer never has to guess
    // which backticks are formatting and which are user content.
    return pr !== undefined ? `#${pr.number} \`${pr.headRef.replace(/`/g, "'")}\`` : s;
  };
  return collisions.map((c) => ({ ...c, prA: label(c.prA), prB: label(c.prB) }));
}

/**
 * Best-effort intent loading for CI. Tries core's IntentStore against
 * CEASEFIRE_INTENTS_DB (or ~/.ceasefire/intents.db); returns [] when unavailable.
 * Intent-level collisions in CI require `ceasefire init` to broadcast intents
 * where the Action can read them — otherwise the forecast is textual-only.
 */
export async function loadIntentsBestEffort(): Promise<Intent[]> {
  const dbPath = process.env['CEASEFIRE_INTENTS_DB'] ?? join(homedir(), '.ceasefire', 'intents.db');
  if (!existsSync(dbPath)) return [];
  try {
    const spec: string = '../intent/store.js';
    const mod = (await import(spec)) as {
      IntentStore?: new (dbPath: string) => { list(opts?: object): unknown; close(): void };
    };
    if (typeof mod.IntentStore !== 'function') return [];
    const store = new mod.IntentStore(dbPath);
    try {
      return store.list({ status: 'active' }) as Intent[];
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

async function fetchPrHead(
  exec: ExecFn,
  workspace: string,
  pr: OpenPR,
  log: (msg: string) => void,
): Promise<string | null> {
  const branch = `ceasefire/pr/${pr.number}`;
  try {
    // Force-update: a PR head that was force-pushed since the last run
    // would otherwise fail a non-fast-forward fetch and be silently
    // excluded from the forecast.
    await exec(
      'git',
      ['fetch', '--no-tags', '--quiet', 'origin', `+pull/${pr.number}/head:${branch}`],
      { cwd: workspace },
    );
    return branch;
  } catch (err) {
    log(
      `ceasefire: warning — could not fetch PR #${pr.number} (${pr.headRef}): ` +
        `${err instanceof Error ? err.message : String(err)} — excluding it from the forecast.`,
    );
    return null;
  }
}

export interface ActionDeps {
  env: ActionEnv;
  listPRs: (opts: { owner: string; repo: string; token: string }) => Promise<OpenPR[]>;
  exec: ExecFn;
  forecastImpl?: ForecastImpl;
  loadIntents: () => Promise<Intent[]>;
  readSignals: () => ClaimSignal[];
  commentApiFor: (prNumber: number, token: string) => CommentApi;
  renderComment: (input: CommentInput) => string;
  setOutput: (name: string, value: string) => void;
  log: (msg: string) => void;
}

export interface ActionResult {
  verdict: Verdict;
  collisionCount: number;
  commented: boolean;
  exitCode: number;
}

function shouldFail(failOn: FailOn, verdict: Verdict): boolean {
  // `fail-on: block` fails the workflow when the verdict is `blocked`
  // (core's Verdict spelling; exit code 3).
  if (failOn === 'block') return verdict === 'blocked';
  if (failOn === 'advisory') return verdict !== 'clear';
  return false;
}

function noComparison(
  deps: ActionDeps,
  reason: string,
): ActionResult {
  deps.log(`ceasefire: ${reason} — nothing to forecast.`);
  deps.setOutput('verdict', 'clear');
  deps.setOutput('collisions', '0');
  return { verdict: 'clear', collisionCount: 0, commented: false, exitCode: 0 };
}

export async function runAction(deps: ActionDeps): Promise<ActionResult> {
  const { env } = deps;

  const prs = await deps.listPRs({ owner: env.owner, repo: env.repo, token: env.token });
  if (prs.length < 2) {
    return noComparison(deps, `only ${prs.length} open PR(s)`);
  }

  const branches: string[] = [];
  for (const pr of prs) {
    const branch = await fetchPrHead(deps.exec, env.workspace, pr, deps.log);
    if (branch !== null) branches.push(branch);
  }
  if (branches.length < 2) {
    return noComparison(deps, `only ${branches.length} PR head(s) could be fetched`);
  }

  let intents: Intent[];
  try {
    intents = await deps.loadIntents();
  } catch {
    intents = [];
  }

  const raw = await forecastBranches(env.workspace, branches, intents, Date.now(), deps.forecastImpl);
  const collisions = labelCollisions(raw, prs);
  const verdict = deriveVerdict(collisions);
  const trigger = env.prNumber !== null ? prs.find((p) => p.number === env.prNumber) : undefined;

  const commentInput: CommentInput = {
    prs,
    collisions,
    verdict,
    claimSignals: deps.readSignals(),
    repoFullName: env.repoFullName,
  };
  if (trigger?.headSha !== undefined) commentInput.triggerSha = trigger.headSha;
  if (env.runUrl !== null) commentInput.runUrl = env.runUrl;

  const body = deps.renderComment(commentInput);

  let commented = false;
  if (env.prNumber !== null) {
    await upsertCollisionComment(deps.commentApiFor(env.prNumber, env.token), body);
    commented = true;
    deps.log(`ceasefire: ${verdict} — ${collisions.length} collision(s); comment upserted on #${env.prNumber}.`);
  } else {
    deps.log('ceasefire: no triggering PR identified — forecast printed to the log instead of a PR comment:');
    deps.log(body);
  }

  deps.setOutput('verdict', verdict);
  deps.setOutput('collisions', String(collisions.length));

  const exitCode = shouldFail(env.failOn, verdict) ? 1 : 0;
  return { verdict, collisionCount: collisions.length, commented, exitCode };
}

function readEventPayloadFile(path: string | undefined): string | null {
  if (path === undefined || path === '') return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const eventPayloadJson = readEventPayloadFile(process.env['GITHUB_EVENT_PATH']);
  const env = readActionEnv(process.env, eventPayloadJson);
  const result = await runAction({
    env,
    listPRs: (opts) => listOpenPRs(opts),
    exec: defaultExec,
    loadIntents: loadIntentsBestEffort,
    // Relativize claim paths against the workspace so absolute agent-
    // machine paths (usernames, homedirs) never reach the PR comment.
    readSignals: () => toClaimSignals(readActiveClaims(), undefined, env.workspace),
    commentApiFor: (n, token) => githubCommentApi(env.owner, env.repo, n, token),
    renderComment: renderCollisionComment,
    setOutput: (name, value) => {
      const file = process.env['GITHUB_OUTPUT'];
      if (file !== undefined && file !== '') appendFileSync(file, `${name}=${value}\n`);
    },
    log: (msg) => console.log(msg),
  });
  if (result.exitCode !== 0) {
    console.error(`ceasefire: verdict is ${result.verdict} — failing the workflow per fail-on=${env.failOn}.`);
  }
  process.exit(result.exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`ceasefire action failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
