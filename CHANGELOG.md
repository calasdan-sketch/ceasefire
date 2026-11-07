# Changelog

## 0.3.0 — unreleased (expert rounds 2 and 3)

### Round 4 (what a stranger gets from `npm i`)

Panel: first-time user on a clean prefix (path with a space), release/packaging engineer, supply-chain reviewer,
Windows/CI reviewer (static), hostile-input tester, docs/DX reviewer. Details and the scored idea list: `docs/ROUND4.md`.

#### Fixed
- **The package had no LICENSE file** although it declares MIT; **no author, repository, homepage, bugs or keywords**;
  27 source maps (pointing at sources that are not shipped) went into the tarball. Now: LICENSE, full metadata,
  `exports` limited to `package.json` (the package is a CLI; `import "ceasefire"` fails with a clear error instead of a
  missing-file error), maps and typings left out. `prepack` rebuilds `dist/` from scratch, so `npm pack` and
  `npm publish` can no longer ship a stale build.
- **`git diff --name-only | ceasefire check --stdin` said "clear" for non-ASCII file names** (git writes them quoted as
  `"caf\303\251.ts"`). Names are now decoded; README uses `-z`.
- **`ceasefire init` in a linked worktree installed the pre-push hook where git never reads it** and still reported
  success. It now uses the folder git reads, and does not write into a `core.hooksPath` hook manager folder (it says so).
- `init` no longer appends `.ceasefire/` to your `.gitignore` (the ledger has lived inside `.git` since 0.3).
- The generated GitHub workflow ran `npx ceasefire@latest`; it now pins the minor line (`ceasefire@0.3`), so a future
  release cannot change your CI by surprise.
- A repository owned by another user (git "dubious ownership") was reported as "not a git repository".
- A read-only or unwritable ledger was reported as "busy, another process may hold a long lock". It now says what is
  wrong; `conflicts` carries on with branch results and a warning.
- `start` printed "published" even when `origin` could not be reached or the claim was too big for other machines to
  accept; it now says so.
- `--help` listed two of the five MCP tools. Node older than 22.13 now gets one plain sentence instead of a stack trace.
- `npm audit` findings in transitive dependencies (`body-parser`, `fast-uri`, reached only through the MCP SDK's HTTP
  code, which ceasefire does not use) are cleared in the lockfile; installs resolve fresh ranges anyway.

#### Not done / not tested
- Windows, macOS, Node 22.13 and Node 24 were not run (see `docs/ROUND4.md`).
- `CEASEFIRE_DIR` pointing into `/proc` hangs inside Node's recursive `mkdir`; not fixed (needs a deliberate bad value).
- The test suite takes about five minutes.

### Round 3

Panel: platform engineer (8 agents, large repo), attacker (planted refs, hostile names), git-internals/performance
engineer, docs/DX lead (README only), competitor engineer (Clash, moire READMEs re-read 2026-11-07), Windows/CI
release engineer, integrator for agents without the Claude hook. A second adversarial pass re-read the new diff and
checked every README claim.

#### Fixed
- **Forecasts left junk in your repository.** `conflicts` wrote every merge result into the object store (about 7,300
  loose objects / 30 MB for 81 branches, per run). Merge results and worktree snapshots now go to a temporary object
  directory with the real store attached as an alternate; the directory is deleted when the command ends. (A repo path
  containing the alternates separator, such as a `:` on Linux, is quoted; found in review, covered by a test.)
- **Cross-machine broadcast silently stopped after 500 intents ever created.** The cap kept the first 500 ref
  *names*, finished ones included, and nothing ever deleted a ref. Live and newest intents now come first, up to 5,000
  refs are inspected, and finished (a day after finishing), long-expired, malformed and oversized refs are deleted
  locally and on `origin`, at most hourly, from `start`, `done` and the session-end hook.
- **A planted intent could hold files forever.** A remote intent expiring more than 7 days (+1 day of clock skew) ahead
  is now dropped (the local maximum was always 7 days). Breaking: a forged far-future intent that used to be imported is
  ignored.
- **Two agents on different machines never warned each other** when both used the default name (`root`, `runner`, `ubuntu`).
  The default is now `user@host`. Intents published under the old default name (`user`) cannot be completed by the new
  name; they expire by themselves (default 4 h).
- `conflicts | head` printed a stack trace (EPIPE); the MCP handshake always reported version 0.1.0; `check .git/config`
  reported contention with a `**` claim; `check` outside a repository said "clear"; a detached HEAD was labelled "unknown"
  (now `detached@<sha>`); `npm run bench` did not reproduce the committed accuracy table (12 vs 40 histories).
- Test fixtures were never deleted (hundreds of directories in the temp folder after a few runs).
- A README correction: the strict hook command written by `init --claude --strict` is `--strict --claim`; the first
  0.3 latency table was measured on repeated (warm) runs, cold numbers are in the README now.

#### Added
- **Fast-forward pairs are skipped** in the all-pairs forecast (equal or ancestor tips cannot conflict). One
  `git rev-list --parents` and a bitset per commit; used only when it pays (pairs >= objects/80). Branch tips are resolved
  in one process. 600 identical branches: 22.9 s -> 0.2 s; 300 stale + 20 diverged: 2.2 s -> 0.26 s. Results identical (tests + accuracy benchmark).
- `start` tells you which other intents already hold your paths and who claimed first (`contested` in JSON), warns
  when a claim covers at least half of the tracked files, and when the agent name is only a guess.
- Intent collisions carry `yields`: the side that should step aside (earlier claim wins, then lower id). The idea of a
  tiebreak both sides compute is moire's; ceasefire's rule is the claim order.
- `check --claim` (hold the files after a clear/advisory check) and `check --stdin` for agents without the Claude hook.
- MCP: `ceasefire_claim`, `ceasefire_release`, `ceasefire_status`; `ceasefire_conflicts` accepts `deep` and `worktrees`.
- `ceasefire doctor [--json]`.
- Benchmark: cold-run methodology, stale-branch case, objects-written column.
- 30 new tests (251 total).

#### Not done / known limits
- The editor hook cannot see edits made by shell commands; Codex `apply_patch` events are not parsed (hook format unverified).
- Windows was exercised through path-fuzzing and the existing Windows-path tests only; no real Windows run.
- Ancestry skipping adds a `rev-list` pass, skipped by a size heuristic on big histories (speed only).
- `--deep` still runs one `merge-base` process per non-related pair; a batched implementation is not built.
- Competitors were not re-installed or re-timed in this round.
- The npm name `ceasefire` currently resolves to 0.0.1; 0.3 is not published.

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
