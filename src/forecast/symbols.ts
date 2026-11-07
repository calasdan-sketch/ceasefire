/**
 * Dependency-light symbol extraction for the semantic forecast.
 *
 * Deliberately regex-based (no tree-sitter, no network, no native build): it
 * finds the *declared exports* and *named imports* of JavaScript/TypeScript and
 * Python files. That is enough to answer one question precisely: "did one
 * branch remove a name that the other branch's new code uses?" It is not a
 * parser: dynamic imports, re-export chains, aliases through `import *` and
 * string-built names are invisible, and comments/strings containing code-like
 * text can produce rare false positives. Every pattern is linear-time (no
 * nested unbounded quantifiers) and inputs are size-capped by the caller.
 */

export type Lang = 'js' | 'py';

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const PY_EXT = /\.py$/i;

export function langOf(path: string): Lang | null {
  if (JS_EXT.test(path) && !/\.d\.[cm]?ts$/i.test(path)) return 'js';
  if (PY_EXT.test(path)) return 'py';
  return null;
}

/** Biggest file (bytes) the analyzer will read. */
export const MAX_ANALYZED_BYTES = 512 * 1024;

const IDENT = '[A-Za-z_$][\\w$]*';

function stripJsNoise(text: string): string {
  // Block and line comments only; strings are left (import specifiers live in them).
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function splitNames(list: string): Array<{ imported: string; local: string }> {
  const out: Array<{ imported: string; local: string }> = [];
  for (const part of list.split(',')) {
    const t = part.replace(/^\s*type\s+/, '').trim();
    if (!t) continue;
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(t);
    if (m) out.push({ imported: m[1] as string, local: (m[2] ?? m[1]) as string });
  }
  return out;
}

/** Names this file makes available to importers. */
export function extractExports(lang: Lang, text: string): Set<string> {
  const out = new Set<string>();
  if (lang === 'js') {
    const src = stripJsNoise(text);
    const decl = new RegExp(`(?:^|[;\\s])export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|abstract\\s+class|const|let|var|enum|interface|type|namespace)\\s+(${IDENT})`, 'g');
    for (const m of src.matchAll(decl)) out.add(m[1] as string);
    for (const m of src.matchAll(/(?:^|[;\s])export\s*\{([^}]*)\}/g)) {
      for (const n of splitNames(m[1] as string)) out.add(n.local);
    }
    if (/(?:^|[;\s])export\s+default\b/.test(src)) out.add('default');
    for (const m of src.matchAll(new RegExp(`(?:^|[;\\s])(?:module\\.)?exports\\.(${IDENT})\\s*=`, 'g'))) out.add(m[1] as string);
    for (const m of src.matchAll(/(?:^|[;\s])module\.exports\s*=\s*\{([^}]*)\}/g)) {
      for (const part of (m[1] as string).split(',')) {
        const k = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
        if (k) out.add(k[1] as string);
      }
    }
  } else {
    for (const m of text.matchAll(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/gm)) out.add(m[1] as string);
    for (const m of text.matchAll(/^class\s+([A-Za-z]\w*)\b/gm)) out.add(m[1] as string);
    for (const m of text.matchAll(/^([A-Za-z]\w*)\s*(?::[^=\n]+)?=[^=]/gm)) out.add(m[1] as string);
  }
  return out;
}

export interface ImportRef {
  /** Module specifier as written (`./a`, `../b/c`, `.pkg.mod`, `pkg.mod`). */
  spec: string;
  /** Named things imported: the exporting module's name and the local name it is used under. */
  named: Array<{ imported: string; local: string }>;
  /** `import * as ns` / `import ns` / `import pkg.mod`: any export may be used through `local`. */
  namespace: string | null;
}

export function extractImports(lang: Lang, text: string): ImportRef[] {
  const out: ImportRef[] = [];
  if (lang === 'js') {
    const src = stripJsNoise(text);
    for (const m of src.matchAll(/(?:^|[;\s])(?:import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"\n]{1,512})['"]/g)) {
      const clause = (m[1] as string).trim();
      const spec = m[2] as string;
      const names: Array<{ imported: string; local: string }> = [];
      let ns: string | null = null;
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) names.push(...splitNames(braces[1] as string));
      const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (star) ns = star[1] as string;
      const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '');
      if (/^\s*[A-Za-z_$][\w$]*\s*,?\s*$/.test(rest) && rest.trim() !== '') names.push({ imported: 'default', local: 'default' });
      if (clause === '*') ns = '*';
      out.push({ spec, named: names, namespace: ns });
    }
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"\n]{1,512})['"]\s*\)/g)) {
      const names = (m[1] as string).split(',').flatMap((p) => {
        const k = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(p);
        return k ? [{ imported: k[1] as string, local: (k[2] ?? k[1]) as string }] : [];
      });
      out.push({ spec: m[2] as string, named: names, namespace: null });
    }
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"\n]{1,512})['"]\s*\)/g)) {
      out.push({ spec: m[2] as string, named: [], namespace: m[1] as string });
    }
  } else {
    for (const m of text.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n#]*)/gm)) {
      const spec = m[1] as string;
      if (spec === '') continue;
      const list = (m[2] as string).replace(/[()\\]/g, ' ');
      const names = list.split(',').flatMap((p) => {
        const k = /^\s*([A-Za-z_]\w*)(?:\s+as\s+(\w+))?\s*$/.exec(p);
        return k ? [{ imported: k[1] as string, local: (k[2] ?? k[1]) as string }] : [];
      });
      out.push({ spec, named: names, namespace: null });
    }
    for (const m of text.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
      out.push({ spec: m[1] as string, named: [], namespace: (m[2] ?? (m[1] as string).split('.').pop() ?? null) });
    }
  }
  return out;
}

const JS_RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

function joinPosix(dir: string, rel: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Resolve an import to a repo file. Only relative JS specifiers and Python
 * imports that map onto a tracked path are resolved; packages from
 * node_modules / site-packages are not ours and resolve to null.
 */
export function resolveImport(lang: Lang, fromFile: string, spec: string, files: ReadonlySet<string>): string | null {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  if (lang === 'js') {
    if (!spec.startsWith('.')) return null;
    const base = joinPosix(dir, spec);
    if (base === null) return null;
    const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, ''); // TS projects import './x.js' for x.ts
    for (const cand of [base, stripped]) {
      for (const ext of JS_RESOLVE_EXT) if (files.has(cand + ext)) return cand + ext;
    }
    return null;
  }
  // Python: leading dots are relative to the importing package; otherwise match a dotted path under any source root.
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
  const rest = spec.slice(dots).replace(/\./g, '/');
  const tryPath = (p: string): string | null => {
    if (files.has(`${p}.py`)) return `${p}.py`;
    if (files.has(`${p}/__init__.py`)) return `${p}/__init__.py`;
    return null;
  };
  if (dots > 0) {
    let d = dir;
    for (let i = 1; i < dots; i++) d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    return tryPath(d ? (rest ? `${d}/${rest}` : d) : rest);
  }
  if (rest === '') return null;
  const direct = tryPath(rest);
  if (direct) return direct;
  const suffix = `/${rest}.py`;
  const hits: string[] = [];
  for (const f of files) if (f.endsWith(suffix)) hits.push(f);
  return hits.length === 1 ? (hits[0] as string) : null; // ambiguous or third-party: unresolved, never guessed
}

/** True when `name` appears as a bare whole identifier in `text` (not as `obj.name`). */
export function mentionsIdentifier(text: string, name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const esc = name.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`).test(text);
}

/** True when `ns.name` appears in `text`. */
export function mentionsMember(text: string, ns: string, name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(ns) || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const e = (x: string): string => x.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$.])${e(ns)}\\.${e(name)}(?![\\w$])`).test(text);
}
