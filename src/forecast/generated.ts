/**
 * Files whose merge conflicts are mechanical: lockfiles, snapshots and
 * generated code. A collision made only of these needs a regenerate, not a
 * negotiation between agents, and should not page anyone or block anything.
 */
export interface RegenRule {
  test: RegExp;
  /** What to run after taking either side. */
  hint: string;
}

const RULES: RegenRule[] = [
  { test: /(^|\/)package-lock\.json$|(^|\/)npm-shrinkwrap\.json$/, hint: 'take either side, then run `npm install` to regenerate' },
  { test: /(^|\/)yarn\.lock$/, hint: 'take either side, then run `yarn install`' },
  { test: /(^|\/)pnpm-lock\.yaml$/, hint: 'take either side, then run `pnpm install`' },
  { test: /(^|\/)bun\.lockb?$/, hint: 'take either side, then run `bun install`' },
  { test: /(^|\/)Cargo\.lock$/, hint: 'take either side, then run `cargo build` (or `cargo update -w`)' },
  { test: /(^|\/)(poetry|uv|Pipfile|composer|Gemfile|flake|pdm|mix)\.lock$|(^|\/)Pipfile\.lock$/, hint: 'take either side, then re-run the package manager lock command' },
  { test: /(^|\/)go\.sum$/, hint: 'take either side, then run `go mod tidy`' },
  { test: /\.snap$|(^|\/)__snapshots__\//, hint: 'take either side, then re-run the tests with the snapshot-update flag' },
  { test: /\.min\.(?:js|css)$|(^|\/)__generated__\/|\.pb\.go$|_pb2(?:_grpc)?\.pyi?$|\.generated\.[a-z]+$/, hint: 'regenerate from the source of truth' },
];

/** The rule that makes `path` regenerable, or null for hand-written files. */
export function regenRule(path: string): RegenRule | null {
  for (const r of RULES) if (r.test.test(path)) return r;
  return null;
}

export function isRegenerable(path: string): boolean {
  return regenRule(path) !== null;
}

/** Hints for a set of files when EVERY file is regenerable; null if any needs a human. */
export function regenHint(files: string[]): string | null {
  if (files.length === 0) return null;
  const hints = new Set<string>();
  for (const f of files) {
    const r = regenRule(f);
    if (!r) return null;
    hints.add(r.hint);
  }
  return [...hints].join('; ');
}
