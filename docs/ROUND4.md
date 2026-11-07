# Round 4 — what a stranger gets from `npm i ceasefire`

Date of the work: 2026-11-07. Branch `expert-2`. Node 22.23.4, npm 10.9, git 2.43, Linux. Nothing was published, tagged or pushed.

**How the panel was run, honestly:** this environment could not start separate reviewer agents, so one agent played each
role in turn, each with its own commands and its own tarball install. They are independent in method, not in mind. Rounds 1 to 3 had the same limit.

## Specialists and findings

| Specialist | Finding (proof command) | Result |
|---|---|---|
| First-time user (clean prefix whose path contains a space; README commands only) | `npm i ./ceasefire-0.3.0.tgz --prefix "…/prefix with space"`, then `ceasefire init --claude`, `doctor`, `start`, `check`, `conflicts`, `--mcp` handshake, `done`: all worked. But `init` edited the repo's `.gitignore` for a folder that no longer exists, and the generated CI file ran `npx ceasefire@latest`. | fixed |
| Release / packaging engineer | `npm pack --dry-run`: **no LICENSE file** though `license: MIT`; no author, repository, homepage, bugs, keywords; 27 `.map` files pointing at sources that are not shipped; 83 files / 129.8 kB. `npm pack` does not run `prepublishOnly`, so a stale `dist/` could ship. `node -e 'import("ceasefire")'` gave `ERR_MODULE_NOT_FOUND` (no entry point). | fixed: 32 files / 82.4 kB, LICENSE, metadata, `exports` limited to `package.json` (error is now `ERR_PACKAGE_PATH_NOT_EXPORTED`), `prepack` does a clean build |
| Supply-chain reviewer | `npm audit --omit=dev`: 2 advisories (`body-parser` high, `fast-uri` moderate), both reached only through the MCP SDK's HTTP code that ceasefire never starts. No install scripts anywhere in the 96-package tree; licenses MIT/ISC/BSD. `npx ceasefire@latest` in generated CI = unpinned code in the user's pipeline. | lockfile fixed (`npm audit` 0 after `npm audit fix`); CI stub pins `ceasefire@0.3` |
| Hostile-input tester | 100 KB task text accepted and stored; remote machines drop anything over 10,000 chars / 64 KB, so the claim silently stayed local. `start` said "published" even with an unreachable `origin`. `git diff --name-only \| ceasefire check --stdin` with a file named `café.ts` returned **"clear"** (git writes `"caf\303\251.ts"`). 20,000 file names to `check`: 3.3 s, fine. 8 parallel `start`: all 8 stored. Bidi/ANSI in agent name: escaped. | fixed (warnings; quote decoding; `-z` in README) |
| Linked worktree / CI integrator | `ceasefire init` inside `git worktree add` wrote the hook to `.git/worktrees/x/hooks/` (git never reads it) and reported success. Repo owned by another user: reported as "not a git repository" (it is git's "dubious ownership"). Read-only checkout: every command stopped with "busy, another process may hold a long lock". | fixed (hook goes to the folder git reads; `core.hooksPath` respected; plain messages; `conflicts` still works without the ledger) |
| Windows reviewer (static only, **not run on Windows**) | See below. | one fix, rest unverified |
| Docs / DX | `--help` listed 2 of 5 MCP tools; README quick start said clone-and-link only; test count and benchmark numbers stale. | fixed |
| Performance | Benchmark re-run (below): accuracy table identical; latency not slower. | none needed |
| Competitor maintainer | GitHub was blocked from this machine (HTTP 403 through the proxy), so Clash and moire READMEs were **not re-read**; crates.io says `clash-sh` last updated 2026-02-08. Round 3's re-read of 2026-11-07 stands. | unverified |

### Windows static review (never run on Windows)

- Git object-directory list separator uses `path.delimiter` (`;` on Windows). OK by reading.
- Child processes are `execFileSync('git', …)`; no `shell: true` anywhere in `src/`. OK.
- Signals: only `SIGKILL` for timeouts. OK.
- stdin is read with `for await (… of process.stdin)`, not `readFileSync(0)`. `\r` is stripped from `--stdin` lines. OK.
- `rename` over an open `.claude/settings.json` can fail with EPERM/EBUSY on Windows: **fixed** (falls back to copy), not exercised.
- The pre-push hook is `#!/bin/sh`; Git for Windows runs hooks with its own sh. Unverified.
- Non-ASCII output on a legacy code page console: bytes are UTF-8; display unverified.
- 8.3 short temp paths versus git's long paths: `realpath` is used, unverified.
- `npm test` uses POSIX shell syntax (`mkdir -p`, `VAR=…`), so contributors cannot run it from cmd.exe. Not fixed.

## What I built and fixed

See `CHANGELOG.md`, "Round 4". 14 new tests in `test/round4.test.ts` (265 total, all pass; 251 before).

## Numbers

- Tests: 251 pass before, 265 pass after (about 105 to 300 s depending on machine load).
- Accuracy benchmark: identical (40 histories, 600 pairs; merge-tree 65 flagged / 80.2% recall; `--deep` 100% recall, 32.9% precision).
- Latency (cold, median of 3; the machine was quieter than in round 3, so all rows are faster): batched forecast 40 / 99 / 373 ms for 10 / 20 / 40 branches (round 3: 52 / 196 / 805); per-pair 197 / 845 / 3509 ms. Writing into the repo is 16 / 55 / 211 ms: leaving no objects behind costs about 160 ms at 40 branches (round 3 called it noise; README corrected).
- Hook p50/p95: check 77/125 ms, with lease 90/139 ms.
- Tarball: 129.8 kB / 83 files before, 82.4 kB / 32 files after.

## Registry versus repo

`npm view ceasefire` (read-only): `latest` is **0.0.1**, published 2026-10-19 by maintainer `decnutz`, 2 files, 903 bytes unpacked, no CLI. The repo is 0.3.0 (the 0.1 and 0.2 lines were never published). **Next release: 0.3.0, no bump needed.** Compared with 0.0.1 it is a different program, not a compatible update. Within the unreleased 0.3 line, breaking changes are listed in `CHANGELOG.md` (far-future forged intents ignored, default agent name `user@host`, `init` no longer edits `.gitignore`, deep imports blocked by `exports`).

## Scored ideas

Scores 1 (low) to 5 (high). Effort S/M/L. Risk L/M/H.

| # | Idea | User value | Differentiation | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| 1 | Ship a LICENSE file | 5 | 1 | S | L | DONE |
| 2 | Complete package.json metadata | 4 | 1 | S | L | DONE |
| 3 | Leave source maps and typings out of the tarball | 2 | 1 | S | L | DONE |
| 4 | `prepack` clean build (no stale dist) | 4 | 1 | S | L | DONE |
| 5 | `exports` limited to package.json (CLI only, no accidental API) | 3 | 1 | S | M | DONE |
| 6 | Plain-English gate for Node older than 22.13 | 4 | 1 | S | L | DONE |
| 7 | `init` hook in the folder git reads (worktrees, hooksPath) | 4 | 2 | S | L | DONE |
| 8 | Stop editing the user's `.gitignore` | 3 | 1 | S | L | DONE |
| 9 | Pin the generated CI to `ceasefire@<minor>` | 4 | 1 | S | L | DONE |
| 10 | Say "dubious ownership" instead of "not a repository" | 4 | 1 | S | L | DONE |
| 11 | Honest ledger errors (busy vs permission) | 3 | 1 | S | L | DONE |
| 12 | `conflicts` works without a writable ledger | 3 | 2 | S | L | DONE |
| 13 | `start` warns on unreachable origin / oversize claim | 4 | 2 | S | L | DONE |
| 14 | Decode git-quoted names for `check --stdin` | 4 | 1 | S | L | DONE |
| 15 | Full `--help`; README quick start via npm | 3 | 1 | S | L | DONE |
| 16 | Clear lockfile audit findings | 2 | 1 | S | L | DONE |
| 17 | Guard test: tarball contents + metadata + CHANGELOG heading | 3 | 1 | S | L | DONE |
| 18 | Real Windows/macOS CI matrix (needs a cross-platform `npm test` first) | 5 | 2 | M | L | NOT-DONE |
| 19 | npm provenance (publish from GitHub Actions with `--provenance`) | 3 | 2 | M | L | NOT-DONE (needs CI and Dan's repo settings) |
| 20 | Root `action.yml` so `uses: calasdan-sketch/ceasefire@v1` works | 4 | 3 | M | M | NOT-DONE (earlier round) |
| 21 | Make the MCP SDK optional (96 packages down to about 1 for non-MCP users) | 3 | 1 | M | M | NOT-DONE: breaks one-line `--mcp` setup |
| 22 | Bundle `dist` into one file | 2 | 1 | M | M | NOT-DONE |
| 23 | Batched `merge-base` for `--deep` | 3 | 2 | M | L | NOT-DONE (earlier round) |
| 24 | Codex `apply_patch` hook | 4 | 4 | M | M | NOT-DONE: hook format unverified |
| 25 | Live `watch` view like Clash | 3 | 1 | M | L | NOT-DONE |
| 26 | Guard `CEASEFIRE_DIR` against `/proc` (Node `mkdir -p` spins) | 1 | 1 | S | L | NOT-DONE |
| 27 | Faster test suite | 2 | 1 | M | L | NOT-DONE |
| 28 | Read-only mode for `check`/`list`/`status` when the ledger cannot be written | 3 | 2 | M | M | NOT-DONE: needs a decision on fail-open versus fail-closed |

## What I could not test

Windows, macOS, Node 22.13 (the stated minimum) and Node 24; a real publish; `npx ceasefire@0.3` (not on the registry); `onFailure: "block"` against a real Claude Code; Clash and moire as they are today; the Python and JS semantic check on real-world repositories; behaviour of the generated workflow on GitHub.
