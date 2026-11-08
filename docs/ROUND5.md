# Round 5: fail closed, Windows-safe scripts, tests that compare against git itself

Date of the work: 2026-11-08. Branch `expert-2`. Node 22.23.4, npm 10.9, git 2.43, Linux. Nothing was published, tagged or pushed.

**How the panel was run, honestly:** this environment could not start separate reviewer agents, so one agent played each
role in turn and ran real commands for each. They are independent in method, not in mind (same as rounds 1 to 4).
Every finding names the command that proved it. Scratch work lived in a private temp folder that was deleted afterwards.

## Author line (done first)

`package.json` `author` was already `Calas Automations Inc.`; `LICENSE` already said `Copyright (c) 2026 Calas Automations Inc.`.
Re-grep of the whole tree (`grep -rniE "decnutz|calasdan|dan calas|DC Enterprises|Calas Automations"`, excluding
`node_modules`, `dist`, lockfile): one wrong label found and fixed, `src/github/action.yml` said `Calas Automations`
(now `Calas Automations Inc.`). The `calasdan-sketch` hits are real GitHub URLs (the repository answers
HTTP 200 unauthenticated on raw.githubusercontent.com, so it is public and the URLs stay) and `decnutz` appears once in the
publish checklist as the npm account name. `--help` now ends with `Maintained by Calas Automations Inc. · MIT license`, read
from `package.json` so it cannot drift. There is no SARIF, JUnit or generated-file header in this project.
Proof that this is what ships: `npm pack --json` then `tar -xzOf ceasefire-0.3.0.tgz package/package.json` prints
`"author": "Calas Automations Inc."`; test `author: the file that npm would publish carries the owner string` does the
same on every test run, and `author: the owner string is exactly ...` pins package.json, LICENSE, action.yml and `--help`.

## Specialists and findings

| Specialist | Finding (proving command) | Result |
|---|---|---|
| Multi-agent git workflow engineer | `git clone --depth 1 --no-single-branch` then `ceasefire conflicts --exit-code`: **exit 0, "no collisions"**, though git refused to merge all 3 pairs ("unrelated histories"; history is missing). Same with a branch whose blob was deleted from `.git/objects`: exit 0. The pair list existed only as stderr warnings; `--json` had no trace. | fixed: `--json` `unchecked` list; `--exit-code` exits 1 for anything but an orphan branch; shallow clone named as cause; `doctor` warns |
| | `git clone --bare` then `ceasefire conflicts`: "not a git repository". | fixed: says it is bare and what to do |
| | clone with only `origin/*` branches: "no collisions across 1 branch(es)". | fixed: says N remote-tracking branches were not compared |
| | `git worktree add`, delete the directory, lock another: prunable and locked worktrees are skipped with a clear warning; no crash. | none needed |
| | GitHub Action: unforecastable PR pairs were dropped with no trace in the workflow log. | fixed: `::warning` lines, control characters removed |
| | `check --stdin` with 20,000 names printed a 224 KB "clear" message (an agent reads every byte). | fixed: 20 names then "… and N more" |
| Merge-conflict researcher | Scratch differential: 200 seeded histories x 4 agents with edits, deletes, renames, adds, chmod, binary, directory-to-file, CRLF, unicode and space names: 1,200 pairs, 250 real conflicts, **0 disagreements** with `git merge` on whether a pair conflicts. A smaller, committed version (10 seeds, 60 pairs) runs in the test suite. | pair-level result matches git |
| | Same run: directory/file conflict listed as `lib~3cbd407e9b83…` (git's object-id name) instead of `lib`; no claim can match it. | fixed |
| | Property test cutting a valid `merge-tree --stdin` stream at every random point: a stream cut right after a file name was accepted as a finished record, listing fewer files than git found. | fixed |
| | Mutation check (below): two of ten mutants survived, so two behaviours had no test. | both now tested |
| | `globMatch` against Node's own `path.matchesGlob`, 4,000 seeded cases on a dot-free subset: all agree. (They differ on purpose for dot-files and a trailing `**`, because a claim `a/**` must cover `a`.) | none needed |
| | `unquoteGitPath` against `git ls-files` vs `git ls-files -z` for 60 random names with quotes, backslashes, tabs, newlines, bidi and ANSI characters: all decode back. | none needed |
| Node/TypeScript packaging maintainer | `npm run prepack` is `rm -rf dist && tsc`; `npm test` is `mkdir -p … && VAR=… node --test <hand-kept list>`. Neither runs from Windows `cmd.exe`, so `npm publish` from a Windows machine would have failed, and a new test file could be silently left out of the list (the test tsconfig had its own list). | fixed: `scripts/test.mjs` finds every `*.test.js`; prepack is a Node one-liner; tsconfig uses `test/**/*.ts`; a test forbids POSIX-only script syntax |
| | No `.gitattributes`: a Windows checkout with autocrlf would give `cli.js` a `#!/usr/bin/env node\r` first line. | fixed: `* text=auto eol=lf` |
| | `npm audit --omit=dev`: 0 vulnerabilities. Lockfile: 98 `resolved` entries, all registry.npmjs.org, name/version 0.3.0. `npm ls --omit=dev`: one dependency. | none needed |
| | Upgrade path: `npm i ceasefire-0.0.1.tgz` (the only published version: 2 files, README and package.json, no CLI, no state) then `npm i ceasefire-0.3.0.tgz` into the same prefix (path with a space): "changed 1 package", `ceasefire --version` prints 0.3.0. 0.0.1 wrote no data, so there is nothing to migrate. | verified |
| | `npm pack` does not run the tests; a broken tree could be published. | `prepublishOnly` runs `scripts/test.mjs` |
| Windows developer (static review, **not run on Windows**) | `canonicalizePath` with `C:\work\repo-other\a.ts` against root `C:\work\repo`; `c:/work/repository/a.ts`; mixed case. Read the code, wrote tests: all correct. | verified by test, on Linux |
| | MCP server finds the CLI as `dist/cli.js` and starts it with `process.execPath`, so no `.cmd` shim is needed. `gh` is started by name with `execFile` (`gh.exe` resolves). Hook commands are plain `ceasefire hook claude`; they need `ceasefire` on PATH, and `doctor` says so. | read only |
| | Many tests use POSIX file modes and `tar`/`npm`; those tests skip themselves on Windows. Nothing here has run on Windows. | `.github/workflows/ci.yml` added (Linux, macOS, Windows x Node 22.13 and 24); never run |

## Quality methods added

- **Differential test against git:** `test/round5.test.ts`, "differential: the textual forecast flags exactly the pairs a real `git merge` stops on". Needs at least 3 real conflicts or it fails (so the generator cannot go quiet).
- **Property tests:** glob matcher vs Node's `matchesGlob`; git quoting vs `ls-files -z`; "a file name claims itself", overlap symmetry and `normalizePath` idempotence over 1,500 generated names; truncated-stream parser.
- **Mutation-style sanity:** `npm run mutation` (`scripts/mutation-check.mjs`) copies the build to a temp folder, breaks one condition at a time and requires the named test files to fail. 11 mutants; first run 8 of 10 killed; after adding tests all killed. The last full run is in the "Numbers" section.
- **Golden files:** `test/golden/` holds the PR comment (clear, advisory, blocked), terminal messages and every `--json` shape (`start`, `check`, `list`, `status`, `conflicts`), with ids, times and durations masked. Refresh deliberately with `UPDATE_GOLDEN=1`.

## Competitors re-checked (read-only; GitHub pages themselves still return 403, raw.githubusercontent.com worked)

- Clash (`clash-sh/clash`, README re-read 2026-11-08): still `watch`, `status`, Claude Code plugin/hook with an "ask" decision, installs for macOS/Linux (Homebrew, curl, cargo), `merge-tree` through the gix library, no Windows mention. crates.io: 0.2.0, last updated 2026-02-08.
- moire (`jamescazzetta/moire`, README re-read): Python 3.8+, "warns, never blocks", uncommitted-work focus, replay measurements on real PRs. Claims in our comparison table still match both READMEs.
- I did not run either tool in this round.

## What I built and fixed

See `CHANGELOG.md`, "Round 5". 25 new tests in `test/round5.test.ts`.

## Numbers

- Tests: 265 pass before, 290 pass after (all pass; about 130 to 220 s depending on machine load).
- Mutation check, last full run: `all 11 mutant(s) killed`.
- Accuracy benchmark (`node bench/accuracy.mjs --histories 40`): output identical to the committed `bench/results/accuracy.txt` (65 textual, 16 breaks-despite-clean-merge, 519 OK; merge-tree 65 flagged / 100% precision; `--deep` 100% recall, 32.9% precision).
- Latency: the machine was much noisier than in round 4 (neighbour load; the same unchanged round-4 build measured 40-branch batched forecasts between 544 and 1,472 ms). Interleaved A/B on the same machine, round-4 code (git HEAD) vs round-5 tree, batched forecast at 10 / 20 / 40 branches: HEAD 57 / 154 / 1215 ms and 92 / 952 / 1472 ms; round 5 62 / 240 / 544 ms and 207 / 631 / 1872 ms. Hook p50: HEAD 70 to 120 ms, round 5 77 to 120 ms. No difference outside the noise, so the committed `bench/results/latency.txt` (taken on a quiet machine in round 4) was left as it is, and the README numbers stand.
- Tarball: 82.4 kB / 32 files before, 84.4 kB / 32 files after (the same file list: `LICENSE`, `README.md`, `package.json`, `dist/**`).

## Registry versus repo

`npm view ceasefire` (read-only, 2026-11-08): `latest` is **0.0.1** (also a `0.0.0-stage`), published 2026-10-19, maintainer `decnutz`, homepage `calasautomations.com`, no CLI. The repo is 0.3.0, unpublished. **Release version: 0.3.0, no bump needed** (nothing was ever published as 0.3.0, so the fixes in this round are part of it).

## Scored ideas

Scores 1 (low) to 5 (high). Effort S/M/L. Risk L/M/H.

| # | Idea | User value | Differentiation | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| 1 | Gate fails closed on unforecastable pairs; `unchecked` in `--json` | 5 | 3 | S | L | DONE |
| 2 | Name shallow clones as the cause; `doctor` warns | 4 | 2 | S | L | DONE |
| 3 | Directory/file conflict reported under the real path | 3 | 2 | S | L | DONE |
| 4 | Truncated `merge-tree --stdin` stream rejected | 3 | 1 | S | L | DONE |
| 5 | Windows-safe `npm test` / `prepack` (Node scripts), auto-discovered tests | 4 | 1 | S | L | DONE |
| 6 | `.gitattributes` (LF) | 3 | 1 | S | L | DONE |
| 7 | CI matrix file for Linux/macOS/Windows x Node 22.13/24 (prior #18) | 5 | 2 | S | L | DONE as a file; never run |
| 8 | `prepublishOnly` runs the tests | 4 | 1 | S | L | DONE |
| 9 | Differential test vs real `git merge` | 4 | 2 | M | L | DONE |
| 10 | Property tests (glob, quoting, paths, stream parser) | 3 | 1 | M | L | DONE |
| 11 | Mutation-style check (`npm run mutation`) | 3 | 2 | M | L | DONE |
| 12 | Golden files for every output format | 3 | 1 | M | L | DONE |
| 13 | Author string single-sourced and pinned by tests (incl. packed tarball) | 4 | 1 | S | L | DONE |
| 14 | Bare-repository message | 2 | 1 | S | L | DONE |
| 15 | Hint when only remote-tracking branches exist | 3 | 1 | S | L | DONE |
| 16 | Action: unforecastable PR pairs as workflow warnings | 3 | 2 | S | L | DONE |
| 17 | Cap file lists in answers (20,000 names no longer print 224 KB) | 3 | 2 | S | L | DONE |
| 18 | `LC_ALL=C` for git so a translated git cannot change decisions | 3 | 1 | S | L | DONE; not testable here (no translated git) |
| 19 | `conflicts --remote` to include remote-tracking branches | 3 | 2 | M | M | NOT-DONE (hint only; needs a decision on which refs to include) |
| 20 | npm provenance (publish from GitHub Actions) (prior #19) | 3 | 2 | M | L | NOT-DONE (needs Dan's repo settings; would add a publish step) |
| 21 | Root `action.yml` so `uses: calasdan-sketch/ceasefire@v1` works (prior #20) | 4 | 3 | M | M | NOT-DONE |
| 22 | Make the MCP SDK optional (prior #21) | 3 | 1 | M | M | NOT-DONE: breaks one-line `--mcp` setup |
| 23 | Bundle `dist` into one file (prior #22) | 2 | 1 | M | M | NOT-DONE |
| 24 | Batched `merge-base` for `--deep` (prior #23) | 3 | 2 | M | L | NOT-DONE |
| 25 | Codex `apply_patch` hook (prior #24) | 4 | 4 | M | M | NOT-DONE: hook format unverified |
| 26 | Live `watch` view like Clash (prior #25) | 3 | 1 | M | L | NOT-DONE |
| 27 | Guard `CEASEFIRE_DIR` against `/proc` (prior #26) | 1 | 1 | S | L | NOT-DONE |
| 28 | Read-only `check`/`list`/`status` when the ledger is unwritable (prior #28) | 3 | 2 | M | M | NOT-DONE: needs a fail-open versus fail-closed decision |
| 29 | Honour `.gitattributes` merge drivers in the forecast | 2 | 2 | M | M | NOT-DONE: unresearched |
| 30 | Sparse-checkout and submodule pairs | 2 | 1 | M | M | NOT-DONE: not tried |

## What I could not test

Windows, macOS, Node 22.13 (the stated minimum) and Node 24; the new CI workflow (it has never run); a translated git
(`LC_ALL=C` is defensive only); GitHub rendering of the `::warning` lines (printed to stdout, which is where the runner
reads workflow commands; not run on GitHub); a real publish (never attempted: not even `npm publish --dry-run`);
`npx ceasefire@0.3` (not on the registry yet); `onFailure: "block"` against a real Claude Code; Clash and moire as
running tools; the semantic check on real-world repositories.
