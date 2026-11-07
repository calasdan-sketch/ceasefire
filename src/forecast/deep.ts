/**
 * Deep forecast: what `git merge-tree` cannot see.
 *
 * merge-tree reports *textual* conflicts. Two agents can still break each
 * other without one: they edit different parts of the same file (a merge
 * that is clean but raced), or one removes/renames an export while the other
 * writes new code that uses it (a merge that is clean and does not compile).
 * Both are common in agent fleets and invisible to every merge-tree tool.
 *
 *  - overlap   (`severity: "overlap"`): both sides changed the same file and
 *              git merged it cleanly. Cheap, noisy, opt-in.
 *  - semantic, high confidence: side X removed an export that side Y's *newly
 *              added lines* use through an import that resolves to that file.
 *  - semantic, low confidence ("neighbors", opt-in): X and Y changed files
 *              joined by an import edge.
 *
 * Everything is derived from `git diff --raw` object ids and blobs read with
 * `git cat-file`: no checkout, no index, no refs, no code execution.
 */
import { execFileSync } from 'node:child_process';
import { cleanGitEnv, git, gitResult } from './git.js';
import { extractExports, extractImports, langOf, mentionsIdentifier, mentionsMember, resolveImport, MAX_ANALYZED_BYTES, type Lang } from './symbols.js';
import type { Collision } from '../types.js';

export interface DeepRef {
  label: string;
  /** Commit id (a branch tip or a worktree snapshot commit). */
  oid: string;
}

export interface DeepOptions {
  overlap?: boolean;
  semantic?: boolean;
  neighbors?: boolean;
  /** Pairs already reported as textual conflicts: `${labelA}\0${labelB}` -> files. Overlap skips those files. */
  textual?: Map<string, string[]>;
  /** Pairs whose tips are equal or ancestor/descendant (fast-forward): skipped without a merge-base. */
  related?: (a: string, b: string) => boolean;
}

export interface DeepResult {
  collisions: Collision[];
  notes: string[];
}

interface Change {
  status: string;
  oldOid: string;
  newOid: string;
  path: string;
}

/** Per-side cap: beyond this the semantic pass is skipped for that pair (noted, never silently wrong). */
export const MAX_CHANGED_FILES = 4000;
const ZERO_OID = /^0+$/;

/** Parse `git diff --raw -z --no-renames --no-abbrev` output. */
export function parseRawDiff(out: string): Change[] {
  const t = out.split('\0');
  const res: Change[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const meta = /^:\d{6} \d{6} ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(t[i] as string);
    if (!meta) break;
    res.push({ status: meta[3] as string, oldOid: meta[1] as string, newOid: meta[2] as string, path: t[i + 1] as string });
  }
  return res;
}

class Blobs {
  private text = new Map<string, string | null>();
  constructor(private cwd: string) {}

  prefetch(oids: Iterable<string>): void {
    const want = [...new Set(oids)].filter((o) => !ZERO_OID.test(o) && !this.text.has(o));
    if (want.length === 0) return;
    const env = cleanGitEnv();
    const sizes = execFileSync('git', ['cat-file', '--batch-check'], { cwd: this.cwd, env, input: want.join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ok: string[] = [];
    sizes.split('\n').forEach((line, k) => {
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(line.trim());
      const oid = want[k] as string;
      if (m && Number(m[2]) <= MAX_ANALYZED_BYTES) ok.push(oid);
      else this.text.set(oid, null);
    });
    if (ok.length === 0) return;
    const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: this.cwd, env, input: ok.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
    let pos = 0;
    for (const oid of ok) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = buf.subarray(pos, nl).toString('utf8').split(' ');
      pos = nl + 1;
      const size = Number(header[2]);
      if (header.length !== 3 || !Number.isSafeInteger(size) || pos + size > buf.length) {
        this.text.set(oid, null);
        break;
      }
      const slice = buf.subarray(pos, pos + size);
      this.text.set(oid, slice.includes(0) ? null : slice.toString('utf8')); // NUL byte: binary, not source
      pos += size + 1;
    }
  }

  get(oid: string): string {
    if (ZERO_OID.test(oid)) return '';
    return this.text.get(oid) ?? '';
  }
}

/** Lines present in `next` more often than in `prev` (a multiset difference, trimmed, blanks dropped). */
export function addedLines(prev: string, next: string): string {
  const counts = new Map<string, number>();
  for (const l of prev.split('\n')) {
    const k = l.trim();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const l of next.split('\n')) {
    const k = l.trim();
    if (!k) continue;
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1);
    else added.push(k);
  }
  return added.join('\n');
}

export function deepForecast(cwd: string, refs: DeepRef[], opts: DeepOptions = {}): DeepResult {
  const collisions: Collision[] = [];
  const notes: string[] = [];
  if (!opts.overlap && !opts.semantic && !opts.neighbors) return { collisions, notes };
  const blobs = new Blobs(cwd);
  const changeCache = new Map<string, Change[]>();
  const treeCache = new Map<string, Set<string>>();
  const changesOf = (base: string, oid: string): Change[] => {
    const key = `${base}\0${oid}`;
    let c = changeCache.get(key);
    if (!c) {
      const r = gitResult(cwd, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, oid]);
      c = r.exitCode === 0 ? parseRawDiff(r.stdout) : [];
      changeCache.set(key, c);
    }
    return c;
  };
  const treeOf = (oid: string): Set<string> => {
    let t = treeCache.get(oid);
    if (!t) {
      const r = gitResult(cwd, ['ls-tree', '-r', '-z', '--name-only', oid]);
      t = new Set(r.exitCode === 0 ? r.stdout.split('\0').filter(Boolean) : []);
      treeCache.set(oid, t);
    }
    return t;
  };

  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const X = refs[i] as DeepRef;
      const Y = refs[j] as DeepRef;
      if (X.oid === Y.oid || opts.related?.(X.oid, Y.oid)) continue;
      let base: string;
      try {
        base = git(cwd, ['merge-base', X.oid, Y.oid]);
      } catch {
        continue; // unrelated histories: textual pass already reported/skipped the pair
      }
      const cx = changesOf(base, X.oid);
      const cy = changesOf(base, Y.oid);
      if (cx.length === 0 || cy.length === 0) continue;
      const already = new Set(opts.textual?.get(`${X.label}\0${Y.label}`) ?? opts.textual?.get(`${Y.label}\0${X.label}`) ?? []);
      const px = new Map(cx.map((c) => [c.path, c]));
      const py = new Map(cy.map((c) => [c.path, c]));

      if (opts.overlap) {
        const both = [...px.keys()].filter((p) => py.has(p) && !already.has(p)).sort();
        if (both.length > 0) {
          collisions.push({
            prA: X.label,
            prB: Y.label,
            files: both,
            severity: 'overlap',
            detail: 'both changed these files; git merges them cleanly, but the edits raced',
            confidence: 'low',
          });
        }
      }

      if (!opts.semantic && !opts.neighbors) continue;
      try {
        semanticPair(X, Y, cx, cy);
      } catch (e) {
        notes.push(`semantic pass failed for ${X.label} <-> ${Y.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { collisions, notes };

  function semanticPair(X: DeepRef, Y: DeepRef, cx: Change[], cy: Change[]): void {
    const px = new Map(cx.map((c) => [c.path, c]));
    const py = new Map(cy.map((c) => [c.path, c]));
    if (cx.length > MAX_CHANGED_FILES || cy.length > MAX_CHANGED_FILES) {
      notes.push(`semantic pass skipped for ${X.label} <-> ${Y.label}: more than ${MAX_CHANGED_FILES} changed files on a side`);
      return;
    }
    const src = (cs: Change[]): Change[] => cs.filter((c) => langOf(c.path) !== null);
    const sx = src(cx);
    const sy = src(cy);
    blobs.prefetch([...sx, ...sy].flatMap((c) => [c.oldOid, c.newOid]));

    if (opts.semantic) {
      for (const [A, B, ca, cb] of [[X, Y, sx, sy], [Y, X, sy, sx]] as Array<[DeepRef, DeepRef, Change[], Change[]]>) {
        const removed = new Map<string, Set<string>>();
        for (const c of ca) {
          const lang = langOf(c.path) as Lang;
          if (c.status !== 'M' && c.status !== 'D') continue;
          const before = extractExports(lang, blobs.get(c.oldOid));
          const after = c.status === 'D' ? new Set<string>() : extractExports(lang, blobs.get(c.newOid));
          const gone = new Set([...before].filter((n) => !after.has(n) && n !== 'default'));
          if (gone.size > 0) removed.set(c.path, gone);
        }
        if (removed.size === 0) continue;
        const treeB = treeOf(B.oid);
        for (const c of cb) {
          if (c.status !== 'A' && c.status !== 'M') continue;
          const lang = langOf(c.path) as Lang;
          const text = blobs.get(c.newOid);
          const added = addedLines(c.status === 'A' ? '' : blobs.get(c.oldOid), text);
          if (!added) continue;
          for (const imp of extractImports(lang, text)) {
            const target = resolveImport(lang, c.path, imp.spec, treeB);
            const gone = target ? removed.get(target) : undefined;
            if (!target || !gone || target === c.path) continue;
            const used = [
              ...imp.named.filter((n) => gone.has(n.imported) && n.imported !== 'default' && mentionsIdentifier(added, n.local)).map((n) => n.imported),
              ...(imp.namespace && imp.namespace !== '*' ? [...gone].filter((n) => mentionsMember(added, imp.namespace as string, n)) : []),
            ];
            if (used.length > 0) {
              collisions.push({
                prA: A.label,
                prB: B.label,
                files: [target, c.path].sort(),
                severity: 'semantic',
                detail: `${A.label} removed ${[...new Set(used)].sort().join(', ')} from ${target}; ${B.label} adds code in ${c.path} that still uses it`,
                confidence: 'high',
              });
            }
          }
        }
      }
    }

    if (opts.neighbors) {
      const already2 = new Set(collisions.filter((c) => c.severity === 'semantic' && c.prA && (c.prA === X.label || c.prA === Y.label) && (c.prB === X.label || c.prB === Y.label)).flatMap((c) => c.files));
      const edges: string[] = [];
      const touch = (from: Change[], to: Map<string, Change>, tree: Set<string>): void => {
        for (const c of from) {
          if (c.status === 'D') continue;
          const lang = langOf(c.path) as Lang;
          for (const imp of extractImports(lang, blobs.get(c.newOid))) {
            const t = resolveImport(lang, c.path, imp.spec, tree);
            if (t && t !== c.path && to.has(t) && !already2.has(t) && !already2.has(c.path)) edges.push(`${c.path} imports ${t}`);
          }
        }
      };
      touch(sy, px, treeOf(Y.oid));
      touch(sx, py, treeOf(X.oid));
      if (edges.length > 0) {
        const uniq = [...new Set(edges)].sort();
        collisions.push({
          prA: X.label,
          prB: Y.label,
          files: [...new Set(uniq.flatMap((e) => e.split(' imports ')))].sort(),
          severity: 'semantic',
          detail: `import neighbors (low confidence): ${uniq.slice(0, 5).join('; ')}${uniq.length > 5 ? ` …+${uniq.length - 5}` : ''}`,
          confidence: 'low',
        });
      }
    }
  }
}
