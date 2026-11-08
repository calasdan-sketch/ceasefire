/** Package version, read once from the installed package.json (works from a checkout and from an npm install). */
import { readFileSync } from 'node:fs';

function readPkg(): { version: string; author: string } {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string; author?: unknown };
      if (pkg.name === 'ceasefire' && pkg.version) return { version: pkg.version, author: typeof pkg.author === 'string' ? pkg.author : AUTHOR_FALLBACK };
    } catch {
      /* try the next location (the test build lives one folder deeper) */
    }
  }
  return { version: '0.0.0', author: AUTHOR_FALLBACK };
}

const AUTHOR_FALLBACK = 'Calas Automations Inc.';
const PKG = readPkg();

export const VERSION = PKG.version;
/** Maintainer name, read from package.json `author` so `--help` can never disagree with the published metadata. */
export const AUTHOR = PKG.author;

/** `0.3` for 0.3.2: what the generated CI workflow pins, so a later 0.4 never changes a user's CI by surprise. */
export function minorLine(version: string = VERSION): string {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return m ? `${m[1]}.${m[2]}` : 'latest';
}

/** True when `node` (e.g. process.versions.node) is at least 22.13, the first release with unflagged node:sqlite. */
export function nodeIsSupported(node: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(node);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || (major === 22 && minor >= 13);
}
