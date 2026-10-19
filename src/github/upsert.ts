/**
 * Idempotent PR comment upsert for the ceasefire collision matrix.
 *
 * The rendered comment carries `COMMENT_MARKER`; upsert finds the existing
 * marked comment and PATCHes it, otherwise POSTs a new one. The Action never
 * spams duplicate comments on re-runs.
 */
import { COMMENT_MARKER } from './comment.js';
import type { FetchFn } from './prs.js';

export interface ListedComment {
  id: number;
  body: string;
}

export interface CommentApi {
  listComments(): Promise<ListedComment[]>;
  createComment(body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}

/** Extract the `rel="next"` URL from a GitHub Link header, if present. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Cap on comment pages: 5 × 100 comments is plenty for finding our marker. */
const MAX_COMMENT_PAGES = 5;

/** REST-backed CommentApi for a specific PR. */
export function githubCommentApi(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  fetchImpl: FetchFn = fetch,
): CommentApi {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  async function check(res: Response, what: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} ${what}: ${body.slice(0, 200)}`);
    }
  }
  return {
    async listComments() {
      // Paginate: without this, a PR with >100 comments would miss our
      // marker on page 2+ and the Action would post a duplicate comment
      // on every run.
      const all: ListedComment[] = [];
      let url: string | null = `${base}/issues/${prNumber}/comments?per_page=100`;
      for (let page = 0; page < MAX_COMMENT_PAGES && url !== null; page++) {
        const res = await fetchImpl(url, { headers });
        await check(res, 'listing comments');
        const comments = (await res.json()) as Array<{ id: number; body?: string }>;
        for (const c of comments) all.push({ id: c.id, body: c.body ?? '' });
        url = nextPageUrl(res.headers.get('link'));
      }
      return all;
    },
    async createComment(body: string) {
      const res = await fetchImpl(`${base}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      });
      await check(res, 'creating comment');
    },
    async updateComment(id: number, body: string) {
      const res = await fetchImpl(`${base}/comments/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
      });
      await check(res, 'updating comment');
    },
  };
}

/** Create or update the ceasefire comment. Returns what happened. */
export async function upsertCollisionComment(
  api: CommentApi,
  body: string,
): Promise<'created' | 'updated'> {
  const comments = await api.listComments();
  const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
  if (existing !== undefined) {
    await api.updateComment(existing.id, body);
    return 'updated';
  }
  await api.createComment(body);
  return 'created';
}
