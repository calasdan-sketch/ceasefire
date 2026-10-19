/**
 * List open PRs for a repo: `gh` CLI first (preinstalled on GitHub runners),
 * GitHub REST API fallback when `gh` is missing or unauthenticated.
 * All I/O is injected for tests.
 */
import { execFile } from 'node:child_process';
import type { OpenPR } from './types.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[], opts: { cwd?: string }) => Promise<ExecResult>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ListPRsOptions {
  owner: string;
  repo: string;
  cwd?: string;
  exec?: ExecFn;
  fetchImpl?: FetchFn;
  token?: string;
}

export function defaultExec(cmd: string, args: string[], opts: { cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err !== null) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

interface GhPR {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  url: string;
  author: { login: string };
  isDraft: boolean;
}

interface RestPR {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  html_url: string;
  user: { login: string };
  draft: boolean;
}

async function viaGh(opts: ListPRsOptions): Promise<OpenPR[]> {
  const exec = opts.exec ?? defaultExec;
  const full = `${opts.owner}/${opts.repo}`;
  const execOpts: { cwd?: string } = {};
  if (opts.cwd !== undefined) execOpts.cwd = opts.cwd;
  const { stdout } = await exec(
    'gh',
    [
      'pr', 'list',
      '-R', full,
      '--state', 'open',
      '--limit', '100',
      '--json', 'number,title,headRefName,headRefOid,baseRefName,baseRefOid,url,author,isDraft',
    ],
    execOpts,
  );
  const prs = JSON.parse(stdout) as GhPR[];
  return prs.map((p) => ({
    number: p.number,
    title: p.title,
    headRef: p.headRefName,
    headSha: p.headRefOid,
    baseRef: p.baseRefName,
    baseSha: p.baseRefOid,
    url: p.url,
    author: p.author.login,
    isDraft: p.isDraft === true,
  }));
}

async function viaRest(opts: ListPRsOptions): Promise<OpenPR[]> {
  const token = opts.token ?? process.env['GITHUB_TOKEN'] ?? '';
  if (token === '') {
    throw new Error(
      '`gh` is unavailable and no GITHUB_TOKEN is set: cannot list PRs via the GitHub API without a token.',
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls?state=open&per_page=100`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} listing PRs for ${opts.owner}/${opts.repo}: ${body.slice(0, 200)}`);
  }
  const prs = (await res.json()) as RestPR[];
  return prs.map((p) => ({
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    baseSha: p.base.sha,
    url: p.html_url,
    author: p.user.login,
    isDraft: p.draft === true,
  }));
}

/** List open PRs, trying `gh` first and the REST API second. */
export async function listOpenPRs(opts: ListPRsOptions): Promise<OpenPR[]> {
  try {
    return await viaGh(opts);
  } catch (ghErr) {
    try {
      return await viaRest(opts);
    } catch (apiErr) {
      const ghMsg = ghErr instanceof Error ? ghErr.message : String(ghErr);
      const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      throw new Error(`Could not list open PRs: gh failed (${ghMsg}); GitHub API failed (${apiMsg})`);
    }
  }
}
