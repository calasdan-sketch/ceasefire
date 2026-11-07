# Changelog

## 0.3.0 — unreleased (expert round 2)

### Fixed
- **Worktrees did not share the ledger without a remote.** The intent store was
  `<worktree>/.ceasefire`, so an agent in one `git worktree` never saw intents from another unless
  a remote relayed them. It now lives in `<git common dir>/ceasefire` (shared by every worktree of
  a clone, and inside `.git`, so it cannot be committed or snapshotted). Old `.ceasefire/` folders
  are not migrated.
- **Two Claude Code sessions of one OS user could never warn each other** (same default agent name,
  and an agent never collides with itself). The hook now names the agent `claude-<session id>`
  unless `CEASEFIRE_AGENT` is set.

### Added
- `conflicts --deep` / `--overlap` / `--semantic` / `--neighbors`: removed-export-still-used
  detection (JS/TS, Python; `severity: "semantic"`, `confidence: "high"`), same-file races
  (`severity: "overlap"`), import-graph neighbors (low confidence). Works on branches and on
  `--worktrees` snapshots. Collisions gain optional `confidence`, `regenerable`, `hint` fields.
- Lockfile/generated-file conflicts are marked `regenerable` with the command to run;
  `--exit-code --ignore-regenerable` lets CI skip them.
- `hook claude --claim` auto-lease (sliding TTL, `CEASEFIRE_LEASE_TTL`), `hook release` for
  `SessionEnd`, `done --all`. `init --claude` now installs both hooks (`--claim` is on for new
  installs; existing installs gain the SessionEnd hook on re-run) and `--statusline` fills an empty
  `statusLine` slot.
- `status [--oneline] [--json]`: who is editing what, from the local ledger, no network.
- `bench/accuracy.mjs` and `bench/latency.mjs` with committed results in `bench/results/`.

### Changed
- All-pairs forecasts use one batched `git merge-tree --stdin` process per 256 pairs (git >= 2.40;
  older gits and any pair the batch cannot answer fall back to one merge per pair): 4.5x / 9.2x /
  12.7x faster for 10 / 20 / 40 branches. Output is identical (checked in the tests and the
  benchmark).
- 33 new tests (221 total). Two existing tests now expect `--claim` in the installed hook command.

## 0.2.0 — unreleased

### Fixed after the independent panel review
- **Data loss:** SQLite lock contention (SQLITE_BUSY after the 5s busy timeout) was
  treated as corruption and moved the live database and its WAL aside, wiping every
  agent's intents. Only SQLITE_CORRUPT / SQLITE_NOTADB now trigger recovery, and a
  recently written WAL/SHM is never moved; contention raises a retryable error instead.
- **Strict hook failed open:** the repo is now resolved from the edited file's path (a
  session `cwd` outside the repo used to allow the edit silently); case-insensitive
  repos fold case; `init --claude --strict` writes `"onFailure": "block"` (Claude Code
  >= v2.1.295) and the hook gains a `--strict` flag.
- **Hook latency:** intent fetches now have a timeout (`CEASEFIRE_FETCH_TIMEOUT_MS`),
  never prompt (`GIT_TERMINAL_PROMPT=0`), are TTL-cached in the hook
  (`CEASEFIRE_FETCH_TTL_S`), skip FETCH_HEAD, and read all intent blobs with one
  `git cat-file --batch` (oversized blobs are no longer read at all).
- `conflicts --worktrees` no longer fetches, so its "no ref written" claim is true.
- File names containing `[` (Next.js `app/[id]/page.tsx`) are no longer treated as globs
  when checked; claims accept `\[` `\]` `\*` `\?` escapes and are stored escaped when they
  name an existing file; glob-vs-glob overlap is now segment-wise, not prefix-only.
- Path canonicalization: Windows case folding, POSIX/MSYS paths under a Windows root,
  `C:/repo2` vs `C:/repo` prefix confusion, drive-relative `C:x` paths (refused) and
  `\\?\` long paths.
- Glob matcher pre-compiles classes (was cubic on unterminated `[`); now O(pattern × path).
- Every git call strips inherited `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, … .
- Docs: snapshot blobs, `gc.pruneExpire`, no size cap, LFS clean filters, transitive
  dependency count, store.ts comment, and the 0.1.0 / "v1.0.0" history note.

### Added
- `ceasefire conflicts --worktrees [--untracked]`: forecast collisions between git worktrees
  **including uncommitted edits**, via throwaway snapshot commits (no checkout, no ref, no
  index writes). Requires git >= 2.38.
- `ceasefire conflicts --exit-code`: exit 2 when any collision is found (default stays 0).
- `ceasefire hook claude [--ask]`: Claude Code PreToolUse hook. Advisory context by default,
  `ask` with `--ask`, `deny` under `CEASEFIRE_STRICT=1`; fails closed in strict mode.
- `ceasefire init --claude`: merges that hook into `.claude/settings.json` without clobbering.
- Glob claims (`src/**/*.test.ts`, `docs/*.md`, `[a-z]` classes) with a linear-time matcher.
- `ceasefire list [--json]`: show active intents. `ceasefire start --ttl 30m|2h|1d`.

### Fixed
- Paths are canonicalized to one repo-relative form: absolute paths (as sent by editor
  hooks), Windows paths, `..`, `//`, symlinked roots and paths relative to a subdirectory
  now match the same claim. Previously `/abs/repo/src/a.ts` never collided with `src/a.ts`,
  and `check a.ts` from `src/` checked the wrong file. Paths outside the repo are refused.
- `suggest`, `done` and the holder list in the blocked message printed agent-supplied text
  unescaped. All terminal output now escapes C1 controls, bidi overrides and zero-width
  characters (shown as `<U+XXXX>`).
- The `node:sqlite` ExperimentalWarning no longer appears on every command's stderr.
- Remote intents with paths over 4096 characters are dropped; local claims over that are refused.
- Tests are hermetic: no longer fail when `GITHUB_TOKEN` is set or when run inside a git checkout.

### Changed
- `engines.node` is now `>=22.13.0` (honest: `node:sqlite` needs a flag before 22.13, so
  22.0–22.12 never worked out of the box).
- README no longer claims zero runtime dependencies (`@modelcontextprotocol/sdk` is one,
  used only by `--mcp`).

## 0.1.0
- Initial release (the first commit is titled "v1.0.0"; the package version was 0.1.0): intent ledger, merge-tree branch forecast, git-refs broadcast, MCP server,
  GitHub Action sources.
