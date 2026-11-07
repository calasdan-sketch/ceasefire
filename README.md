# ceasefire — parallel agents, zero merge fights

**Know before you edit that another AI agent is already working on that file — across branches, worktrees, uncommitted edits and machines.**

`ceasefire` keeps parallel AI coding agents (Claude Code, Codex, Cursor, your own) from
stepping on each other's files. Three mechanisms:

1. **Intent ledger** — agents publish soft, expiring, *advisory* intents
   ("I'm about to work on `src/auth/` and `src/**/*.test.ts`"). `ceasefire check` warns
   before you edit files another agent holds. Intents never block unless you opt in.
2. **Merge-tree forecast** — `ceasefire conflicts` runs a real `git merge-tree`
   pairwise across local branches and reports textual collisions before anyone pushes.
3. **Worktree forecast (new in 0.2)** — `ceasefire conflicts --worktrees` snapshots every
   `git worktree` checkout, *including uncommitted edits*, and forecasts collisions between
   agents that have not committed anything yet. No checkout, no ref, no index write, no fetch
   (only unreferenced snapshot objects are added; see below).

4. **Deep forecast (new in 0.3)** — `ceasefire conflicts --deep` finds what `git merge-tree`
   cannot: a branch that *removes or renames an export* while another branch writes new code
   that still uses it. Git merges that cleanly and the result does not link. Same-file races
   (`overlap`) and lockfile-only conflicts (marked *regenerable*, with the fix) are classified too.
5. **Zero-effort leases (new in 0.3)** — the Claude Code hook keeps a sliding 15-minute lease on
   every file a session edits, named after the session, so parallel sessions warn each other
   with no `ceasefire start`, and a crashed session frees its files by itself.

6. **Read-only forecasts, tidy ledger (new in 0.3)** — forecasts write nothing into your repository
   (merge results and worktree snapshots live in a temporary object directory that is deleted
   afterwards), fast-forward branch pairs are skipped exactly, and finished broadcast intents are
   pruned instead of piling up as refs.
7. **Works for agents without the Claude hook (new in 0.3)** — `ceasefire check --claim` and the MCP
   tools `ceasefire_claim` / `ceasefire_release` / `ceasefire_status` give Codex, Cursor or any MCP client the
   same "say what you are editing, hear who else is" loop; `ceasefire doctor` tells you what is missing.

No daemon. No lock server. Advisory by default, strict opt-in.

## Quick start (60 seconds)

```sh
npm i -g ceasefire                 # puts `ceasefire` on PATH (needs Node >= 22.13 and git)
cd your-repo
export CEASEFIRE_AGENT=my-agent    # a different name per agent; agents that share a name never warn each other
ceasefire init --claude            # pre-push hook + workflow stub + Claude Code hook
ceasefire doctor                   # what is installed, what is missing
```

**Version note (checked 2026-11-07).** The npm name `ceasefire` resolves to 0.0.1, an early placeholder without
this code. Everything below describes 0.3.0. Until 0.3.0 is published, install from a checkout instead of `npm i -g`:

```sh
git clone https://github.com/calasdan-sketch/ceasefire && cd ceasefire
npm ci && npm run build && npm link   # `npm link` puts `ceasefire` on PATH
```

Without installing anything: `npx ceasefire@0.3 doctor` (once published).

Synthetic demo (two agents, made-up names):

```console
$ CEASEFIRE_AGENT=builder ceasefire start "refactor login" --paths src/auth/
ceasefire: intent 1f0c9a2e published by "builder" on feat/login (expires in 3h 59m). Release with `ceasefire done`.

$ CEASEFIRE_AGENT=reviewer ceasefire check /abs/path/to/repo/src/auth/session.ts
CEASEFIRE VERDICT: ADVISORY — another agent is actively working on these files.
...
Holder: agent "builder" (branch feat/login, intent 1f0c9a2e — "refactor login", expires in 3h 59m)
Files in contention:
  - src/auth/session.ts
Recommended next actions:
  1. Pick different files: run `ceasefire suggest` for unclaimed alternatives you can work on now.
  ...

$ CEASEFIRE_AGENT=reviewer ceasefire start "fix session bug" --paths src/auth/session.ts
ceasefire: intent 8c1d77e0 published by "reviewer" on fix/session (expires in 3h 59m). Release with `ceasefire done`.
ceasefire: heads-up — 1 other intent(s) already hold some of these paths:
  "builder" on feat/login (1f0c9a2e, "refactor login", expires in 3h 58m): src/auth/session.ts — claimed before you
  The earlier claim keeps priority. If theirs is earlier, pick other files (`ceasefire suggest`) or coordinate before editing.

$ ceasefire conflicts --worktrees
ceasefire: 1 collision(s) across 3 worktree(s) (2 with uncommitted changes):
  [TEXTUAL] agent-a [worktree] <-> agent-b [worktree]
      files: src/app.ts
      agent-a: uncommitted changes; agent-b: uncommitted changes
```

Requirements: Node >= 22.13 (uses the built-in `node:sqlite`, unflagged since 22.13 —
[Node docs](https://nodejs.org/api/sqlite.html)) and git (git >= 2.38 for rename/binary-aware
detection and for `--worktrees`; older gits fall back to a legacy parser for branches).
One direct runtime dependency, `@modelcontextprotocol/sdk`, loaded only by `ceasefire --mcp`;
note that installing ceasefire still pulls its transitive tree (95 packages in the current
lockfile) even if you never use `--mcp`.

## Agent workflow (1 line for AGENTS.md)

```sh
ceasefire check <files...>   # before editing shared files
```

```sh
ceasefire start "refactor login" --paths src/auth/login.ts src/auth/
# ... work ...
ceasefire done
```

## Commands

| Command | Effect |
|---|---|
| `ceasefire init [--claude] [--statusline]` | Installs advisory pre-push hook (in the folder git really reads, also from a linked worktree; skipped with a note when `core.hooksPath` is set) + `.github/workflows/ceasefire.yml` stub pinned to `ceasefire@<minor>`; never edits `.gitignore`; `--claude` also merges the PreToolUse (auto-lease) and SessionEnd hooks into `.claude/settings.json`; `--statusline` fills an empty `statusLine` slot |
| `ceasefire check <files...> [--json] [--claim] [--stdin]` | Pre-edit collision check. `--claim` also holds the files (auto-lease, for agents without the Claude hook); `--stdin` reads more names from a pipe (`git diff --name-only -z \| ceasefire check --stdin`; with `-z` names are exact, without it git quotes non-ASCII names and ceasefire decodes that quoting). `.git/` paths are ignored; outside a repository it is an error, not "clear" |
| `ceasefire start "<task>" --paths <...> [--ttl 30m]` | Publish an intent (default 4h TTL, 1m–7d; broadcast via git refs). Paths may be files, directories or globs. Tells you who already holds some of the paths and who claimed first, and warns when the claim covers most of the repository or your agent name is only a guess |
| `ceasefire done [--id <id>]` | Complete your active intent |
| `ceasefire list [--json]` | Active intents from every agent |
| `ceasefire conflicts [--json] [--exit-code]` | Collision matrix: textual (branches) + intent (agents) |
| `ceasefire conflicts --worktrees [--untracked]` | Same, across worktrees including uncommitted edits |
| `ceasefire suggest [files...] [--json]` | Unclaimed files to work on instead |
| `ceasefire conflicts --deep [--neighbors]` | Add removed-export-still-used (semantic, high confidence), same-file races (overlap); `--neighbors` adds import-graph neighbors (low confidence, noisy) |
| `ceasefire conflicts --exit-code --ignore-regenerable` | CI gate that ignores lockfile/generated-only conflicts |
| `ceasefire status [--oneline] [--json]` | Who is editing what right now, contested files; `--oneline` is a status-line string |
| `ceasefire done --all` | Complete all of your intents |
| `ceasefire hook claude [--ask] [--strict] [--claim]` | Claude Code PreToolUse hook (run by Claude Code, reads stdin); `--claim` = auto-lease |
| `ceasefire hook release` | Claude Code SessionEnd hook: free this session's leases |
| `ceasefire doctor [--json]` | Checks Node/git versions, ledger, agent name, Claude hook, `ceasefire` on PATH, pre-push hook, remote sync |
| `ceasefire --mcp` | MCP stdio server: `ceasefire_check`, `ceasefire_conflicts` (optional `deep`, `worktrees`), `ceasefire_claim`, `ceasefire_release`, `ceasefire_status` |

Exit codes: `0` clear · `1` error · `2` advisory · `3` hard block.
`conflicts` exits `0` unless `--exit-code` is given (then `2` on any collision).

### Paths: one file, one name

Every claim and every checked path is reduced to one repo-relative form, so agents that
name a file differently still collide: `src/a.ts`, `./src/a.ts`, `/home/u/repo/src/a.ts`,
`src\a.ts`, `C:\repo\src\a.ts`, and `a.ts` run from `src/` are all `src/a.ts`.
Symlinked checkouts are resolved. Paths that leave the repository are refused (exit 1).

Glob claims: `*` and `?` stay inside one path segment, `**` spans any number of
segments, `[a-z]` / `[!x]` classes work; `\[`, `\]`, `\*`, `\?` are literal characters
(the only place a backslash is not a path separator). Patterns are compiled once and
matched in O(pattern × path) time; no regex is built from claim text. Files being
*checked* are always literal, so `app/[id]/page.tsx` is a file name, never a pattern, and
`ceasefire start --paths app/[id]/page.tsx` stores the claim escaped when that file exists. Glob-vs-glob overlap is checked segment by segment: two wildcard
segments are assumed to overlap (conservative), literal segments must agree, so
`app/[id]/page.tsx` and `app/[slug]/layout.tsx` do not collide. On case-insensitive
repositories (Windows paths, or git's `core.ignorecase=true`, the default on macOS
volumes created that way) every comparison folds case.

### Claude Code hook

`ceasefire init --claude` adds this to `.claude/settings.json` (existing settings are kept;
an unparseable file is left untouched):

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit|NotebookEdit",
    "hooks": [ { "type": "command", "command": "ceasefire hook claude --claim", "timeout": 30 } ] } ],
  "SessionEnd": [ { "hooks": [ { "type": "command", "command": "ceasefire hook release", "timeout": 10 } ] } ] } }
```

`ceasefire init --claude --strict` writes a gate instead:

```json
{ "type": "command", "command": "ceasefire hook claude --strict --claim", "timeout": 30, "onFailure": "block" }
```

Behaviour ([hook protocol](https://code.claude.com/docs/en/hooks)): clear edits get no output;
advisory collisions add the holder and next actions to Claude's context without
interrupting; `--ask` turns that into a permission prompt; `--strict` (or
`CEASEFIRE_STRICT=1`) denies the edit. The repository is found from the edited file's
path, not the session's directory, so a session started above several worktrees is still
checked. In strict mode a malformed event or internal error denies. A hook that cannot run
at all (missing from PATH, timed out, crashed) can only be blocked by Claude Code itself:
that is what `"onFailure": "block"` does, and it needs Claude Code v2.1.295 or later — on
older versions such failures let the edit through. Files outside any git repository are
ignored.

Remote intents are refreshed with a bounded fetch (`CEASEFIRE_FETCH_TIMEOUT_MS`, default
5000), never prompting for credentials. The hook caches that fetch for
`CEASEFIRE_FETCH_TTL_S` seconds (default 30, `0` = every edit); explicit commands always fetch.

### Auto-lease and session identity (0.3)

With `--claim` the hook records every edited file in one implicit intent per agent and branch
("editing (auto-lease)"), refreshing it on each edit (`CEASEFIRE_LEASE_TTL`, default 15m; 1m-7d). A
session that stops editing, crashes or loses power releases its files at the end of the TTL; a clean
exit releases them at once through the `SessionEnd` hook. When `CEASEFIRE_AGENT` is not set, the hook
names the agent `claude-<session id>`, so two sessions run by one OS user are two agents (before
0.3 they shared the username, and a session never collides with itself). Remote machines see a lease
when it is created and at most every `CEASEFIRE_LEASE_BROADCAST_S` (default 30) seconds after a new
file is added.

The ledger now lives in `<git common dir>/ceasefire/`, shared by the main checkout and every
`git worktree`. In 0.2 it lived in `<worktree>/.ceasefire`, so agents in separate worktrees of one
clone could not see each other unless a remote was configured. State in the old location is not
migrated (intents are short-lived); it can be deleted.

### Deep forecast (0.3)

`ceasefire conflicts --deep` (branches, or `--worktrees` for uncommitted work) adds two checks that run
on object ids and blobs read with `git cat-file`: nothing is checked out and no code is executed.

- **semantic, high confidence** — branch X removed or renamed an export of `lib` and branch Y's *added
  lines* use that name through an import that resolves to `lib` (named, aliased, `import * as`,
  CommonJS destructuring; Python `from .lib import name`). Works for JavaScript/TypeScript and Python
  only. It is a regex-level reader, not a type checker: dynamic imports, re-export chains, signature
  changes and anything built from strings are invisible.
- **overlap** — both branches changed the same file and git merged it cleanly. Cheap and noisy
  (29% precision in the benchmark below); use it as a "read both diffs" nudge, not a gate.
- `--neighbors` adds import-graph neighbors (low confidence, 17% precision); off by default.

Cost: `--deep` runs one `merge-base` per pair that is not a fast-forward, about 3.7 s for 40 branches (780 pairs) in the benchmark.

### Worktree forecast details

For each worktree, ceasefire copies its index to a temp file, runs `git add -u` (or `-A`
with `--untracked`) against that copy, and writes a throwaway commit object that no ref
points at, then merges the snapshots pairwise with `git merge-tree --write-tree`.
Intent collisions in this mode use only intent refs already fetched; nothing is fetched.

What that writes, honestly:

- **Nothing in your repository's object store (new in 0.3).** Every object a forecast creates
  (snapshot blobs and commits, merge-result trees) goes to a temporary directory
  (`GIT_OBJECT_DIRECTORY`, with the real store attached read-only as an alternate) that is deleted when the
  command ends. Before, one forecast across 81 branches left about 7,300 loose objects (30 MB) behind
  until `git gc` pruned them two weeks later. If git cannot report its objects directory the forecast
  falls back to the old behaviour: the content of **modified tracked files** (and, with `--untracked`, of new
  non-ignored files) is stored as unreferenced loose objects, never pushed, which `git gc` deletes only once they
  are older than `gc.pruneExpire` (2 weeks by default). The temporary directory is under your OS temp folder, so
  `--untracked` content briefly exists there; it is removed even on errors, but a hard kill
  (`kill -9`) can leave a `ceasefire-q-*` folder behind.
- There is **no size cap**: `--untracked` hashes every non-ignored new file, so keep build
  output, `node_modules` and secrets in `.gitignore`.
- Clean filters run as for a normal `git add` — for example Git LFS will store LFS objects
  under `.git/lfs` for changed LFS-tracked files. That is outside the object directory and is
  **not** quarantined.
- Inherited `GIT_DIR`, `GIT_INDEX_FILE` and similar variables are removed from every git
  call ceasefire makes, so running inside a git hook cannot redirect the snapshot.

### Fast-forward pairs are skipped

If one branch tip is an ancestor of (or equal to) another, merging them is a fast-forward and cannot
conflict, so the all-pairs forecast leaves those pairs out. This is exact, not a heuristic: it comes from one
`git rev-list --parents` over the tips, with a bitset per commit (equal tips are always skipped for free). The walk is only done when
the number of pairs is large next to the size of the repository (roughly pairs ≥ objects/80), because on a
100,000-commit history it costs about 0.8 s. It changes speed only; the test suite checks that results are identical
with and without it.

## Benchmarks (re-runnable: `npm run bench`)

Both scripts are plain Node in `bench/`, generate their own repositories, and print the numbers
below. Raw output of the run quoted here is in `bench/results/`.

**Accuracy** (`bench/accuracy.mjs`): 40 generated histories x 6 agents, 600 agent pairs. Each agent
branch does 1-2 tasks (edit a function body, rename an export everywhere it is used, add a caller of
an existing function, bump a lockfile entry, add a module). Ground truth for every pair comes from
outside ceasefire: a real `git merge`, and, when it is clean, a real `node` import of every module
(a missing export fails ES-module linking). 65 pairs conflict textually, 16 merge cleanly and then
fail to link, 519 are fine.

| detector | pairs flagged | precision | recall | recall of the 16 clean-but-broken |
|---|---|---|---|---|
| `git merge-tree` only (0.2 behaviour) | 65 | 100% | 80.2% | 0% |
| + `--overlap` | 234 | 29.5% | 85.2% | 25% |
| + `--semantic` | 81 | 100% | 100% | 100% |
| `--deep` (overlap + semantic) | 246 | 32.9% | 100% | 100% |
| `--deep --neighbors` | 465 | 17.4% | 100% | 100% |

Read this honestly: the histories are synthetic and the task mix was written to include the case
the semantic check targets, so 100% recall means "finds every instance of the failure the generator
makes", not "finds real-world breakage". The one external data point I could find, from moire's
own README, is a *measured base rate of 0 of 672 audited real agent-PR pairs* that merged cleanly
and then broke semantically
([source](https://github.com/jamescazzetta/moire), unverified by me): in real fleets the class is
rare, and `--deep` is an opt-in extra, not the default.

**Latency** (`bench/latency.mjs`, git 2.43, Node 22, 2 CPUs, on a machine shared with other jobs: identical runs
varied by +-30%, so read these as orders of magnitude). Every forecast timing is a **cold** run on a fresh
repository, median of 3:

| all-pairs forecast | 10 branches (45 pairs) | 20 (190) | 40 (780) |
|---|---|---|---|
| one git process per pair | 197 ms | 845 ms | 3509 ms |
| batched `merge-tree --stdin` (0.3, writes nothing into the repo) | 40 ms | 99 ms | 373 ms |
| speed-up | 5x | 8.6x | 9.4x |
| `--deep` | 282 ms | 971 ms | 3644 ms |
| batched, merge results written into the repo (what 0.3 did before round 3) | 16 ms | 55 ms | 211 ms |

(Round 4 re-run on a quieter machine: every row is faster than the round 3 run, which measured 52 / 196 / 805 ms for the
batched row. The ratios, not the milliseconds, are the stable part.)

Correction to the first 0.3 numbers (43 / 88 / 249 ms, 4.5x / 9.2x / 12.7x): that benchmark repeated the same
forecast on one repository, and git skips writing objects it already has, so every repeat was warm. Cold runs are
what a real `conflicts` call sees. Keeping the repository clean costs a fixed ~20 ms of extra git processes (finding the object
directory, resolving tips, deciding about the ancestry walk) plus a share that grows with the number of pairs: in the
round 4 run, 373 ms quarantined against 211 ms written into the repo at 40 branches. Round 3 had called that difference
"within the noise"; the table says otherwise, so treat it as a real cost of leaving no objects behind.

Many stale branches (`bench/latency.mjs`, 300 branches that sit on `main` plus 20 diverged agent branches, 51,040 pairs):
every pair 1855 ms, fast-forward pairs skipped 137 ms. One forecast of the 20 diverged branches added 400 loose objects
to the repository before round 3 and adds 0 now. (Separately, by hand: `conflicts` on 600 branches that all point at one commit took 22.9 s
and now takes about 0.2 s.)

Editor hook, whole process as Claude Code runs it (p50 / p95 of 25): node start-up alone 28/42 ms;
check only 77/125 ms; with auto-lease 90/139 ms; with 200 intents in the ledger 88/111 ms.

Against Clash 0.2.0 (built from crates.io; measured in round 2, not re-run in round 3) on the same 10 worktrees with uncommitted edits (median
of 7): `clash status --json` 54 ms vs `ceasefire conflicts --worktrees` 274 ms; `clash check` 29 ms vs
`ceasefire hook` 86 ms. Clash is faster per call (native binary, no Node start-up); ceasefire's edge
is what it can see, not raw speed.

## Environment

| Var | Effect |
|---|---|
| `CEASEFIRE_JSON=1` | Force JSON output |
| `CEASEFIRE_STRICT=1` | Advisory becomes a hard block (exit 3) |
| `CEASEFIRE_ALLOW_CONFLICT=1` | Proceed anyway (exit 0, risk accepted) |
| `CEASEFIRE_AGENT=<name>` | Agent identity (default: OS username) |
| `CEASEFIRE_DIR=<dir>` | Intent store location |
| `CEASEFIRE_SYNC=0` | Disable git-refs broadcast |
| `CEASEFIRE_FETCH_TIMEOUT_MS=<ms>` | Cap on each intent fetch/push (default 5000, 500–60000) |
| `CEASEFIRE_FETCH_TTL_S=<s>` | Hook-only fetch cache (default 30, 0 = always) |
| `CEASEFIRE_CLAIM=1` | Same as `hook claude --claim` |
| `CEASEFIRE_LEASE_TTL=<30m>` | Auto-lease lifetime after the last edit (default 15m) |
| `CEASEFIRE_LEASE_BROADCAST_S=<s>` | Minimum seconds between lease broadcasts to other machines (default 30) |

The blocked-agent message is written for an LLM reader: verdict first,
named holder, numbered next actions, a `ceasefire suggest` alternative, and
the `CEASEFIRE_ALLOW_CONFLICT=1` override.

## How it compares

Competitor statements come from each project's own README (linked; Clash's and moire's READMEs were
re-read on 2026-11-07; in round 4 GitHub was not reachable from the test machine, so they were not re-read again. The crates.io
record of `clash-sh` showed its last update on 2026-02-08). The only competitor I ran is Clash 0.2.0 (timings
above, measured in round 2; not re-run in round 3); everything else is unverified by me.

| | ceasefire | [Clash](https://github.com/clash-sh/clash) | [moire](https://github.com/jamescazzetta/moire) | [AGNT-LOCK](https://github.com/codewithriza/AGNT-LOCK) | [agent-claim-mcp](https://github.com/vk0dev/agent-claim-mcp) | [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) |
|---|---|---|---|---|---|---|
| Approach | intents + merge-tree forecast | merge-tree across worktrees | merge-tree across worktrees | file locks (MCP) | file claims (MCP) | messaging + file reservations |
| Sees uncommitted work | yes (`--worktrees`) | yes | yes | n/a | n/a | n/a |
| Declared intent before any edit | yes | no | no (by design) | yes (lock) | yes (claim) | yes (reservation) |
| Glob / directory claims | both | n/a | n/a | not documented | not documented | globs |
| Cross-machine | git refs broadcast | no | no | no (local JSON) | no (local JSON) | server |
| Claude Code hook | yes | yes | — | — | — | — |
| Can hard-block | opt-in | "ask" decision | no (warn-only by design) | yes | yes | pre-commit guard |
| Semantic check | removed-export-still-used, JS/TS + Python, no checkout (`--deep`) | no | yes, post-merge, Python imports | no | no | no |
| Zero-effort lease from the editor hook | yes (`--claim`, session-named, TTL) | no | no | no | no | no |
| Lockfile/generated conflicts told apart | yes (marked regenerable + fix) | no | no | n/a | n/a | n/a |
| Live view | `status [--oneline]` + status line | `watch` TUI | no | n/a | n/a | web UI |
| Says which side should step aside | intent collisions: the earlier claim keeps the files (`yields`) | not documented | yes, a name-based tiebreak both sides compute | n/a | n/a | n/a |
| Non-Claude agents | `check --claim`, `check --stdin`, MCP claim/release/status | JSON output, CLAUDE.md-style instructions | CLI | MCP | MCP | MCP |

Worktree managers and session multiplexers
([Claude Squad](https://github.com/smtg-ai/claude-squad), [worktrunk](https://github.com/max-sixty/worktrunk),
[ccmanager](https://github.com/kbwo/ccmanager), [Conductor](https://www.conductor.build)) give each agent
an isolated worktree; their READMEs do not describe cross-agent conflict forecasting. GitHub's
[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
runs required checks on speculative combinations of completed pull requests: real semantic
verification, but at the end of the lifecycle, not while agents are editing.

What others do better today: Clash ships a live `watch` TUI and is several times faster per call;
moire runs an optional post-merge semantic check *by actually running a checker* and publishes
replay measurements on real agent PRs; mcp_agent_mail adds agent-to-agent messaging and a web UI;
a merge queue verifies the real merged result with your real CI.

## Layout (core)

- `src/intent/` — SQLite intent store (TTL, upsert for remote intents)
- `src/forecast/` — `git merge-tree` collision engine (batched, object-quarantined, fast-forward pairs skipped in `ancestry.ts`), worktree snapshots, deep/semantic forecast, path canonicalization + globs
- `bench/` — accuracy and latency benchmarks with committed results
- `src/cli/` — commands, Claude Code hook, blocked-agent formatting, git-refs sync
- `src/github/`, `src/mcp/`, `src/claimlock/` — Action, MCP server, claimlock adapter

Honest limits:

- `git merge-tree` cannot see same-file *disjoint* edits (they merge cleanly). The
  intent ledger and `--overlap` cover that case advisorially. `--deep` catches one specific
  semantic failure (a removed export that the other side's new code uses) for JavaScript/TypeScript
  and Python; it does not catch changed behaviour, changed signatures, duplicate symbols, or
  anything a compiler or test run would find. For those, run your real CI on the merged result.
- The editor hook only sees the file-writing tools (Write, Edit, MultiEdit, NotebookEdit). Edits made by a
  shell command (`sed -i`, a formatter, `git checkout`) are invisible to it; `--worktrees` still sees the result.
  Codex-style `apply_patch` events are not parsed (their hook format was not verified); those agents use
  `ceasefire check --claim` or the MCP tools.
- A symlink is its own path: an edit through `link.ts` is not matched against a claim on its target.
- Ancestry skipping adds one `git rev-list` pass; on very large histories it is skipped by a size heuristic
  (it affects speed only). `--deep` still runs one `git merge-base` per non-related pair.
- `--worktrees` compares worktrees of *one* clone; agents in separate clones or on
  other machines are covered by branches + the intent broadcast instead.
- The workflow stub from `init` only forecasts the branches present in the CI checkout.
  The full PR-matrix Action lives in `src/github/` and is not yet published as a
  root-level `action.yml`, so `uses: calasdan-sketch/ceasefire@v1` does not work yet.
- Agent identity is self-asserted (see below).
- **Windows has never been run.** Path handling, the `;` list separator for git object directories, CRLF input and
  `rename` over open files were reviewed in code and covered by path-fuzz tests only. If it misbehaves on Windows,
  that is a bug to report, not a documented limit.
- Only Node 22.23 was run for this release; 22.13 (the stated minimum) and Node 24 are untested here. Older Node
  prints one plain sentence and exits 1.
- A checkout the current user does not own is refused by git ("dubious ownership", common in Docker); ceasefire now
  says so and prints the `safe.directory` command instead of "not a git repository".
- On a read-only checkout, `conflicts` still forecasts branches (with a warning that intents are missing);
  `check`, `start`, `list`, `status` stop with a plain message, because they need the ledger.
- A claim of more than 1,000 paths or 64 KB is kept locally but other machines ignore it (`start` now says so).

## Trust model

Ceasefire coordinates **trusted-but-uncoordinated** agents. Know the boundaries:

- **Agent identity is self-asserted.** `CEASEFIRE_AGENT` (or the OS username, or the Claude Code
  session id in the hook)
  is a label, not an authentication. Any agent on the machine can publish
  intents as another agent, or complete another agent's intents with
  `ceasefire done`. Intents are advisory, so the blast radius is bad advice —
  not a security boundary. In adversarial fleets, treat the ledger as
  hints and keep `CEASEFIRE_STRICT=1` decisions human-gated.
- **Broadcast intents are validated, not trusted.** Anyone with push
  access can plant `refs/ceasefire/intents/*` refs. Fetched intents are
  shape-checked, size-capped (64KB), count-capped (500 kept, live and newest first, out of at most
  5,000 refs inspected), and ids must be ref-safe — malformed or absurd ones are dropped, never imported.
  An intent whose expiry is more than 7 days (plus a day of clock skew) away is dropped too, so a planted
  claim cannot hold files, or under strict mode block edits, forever. A forged claim *within* those bounds
  still holds its paths until it expires: treat strict mode as a gate you can lift (`CEASEFIRE_ALLOW_CONFLICT=1`).
  Finished, long-expired, malformed and oversized refs are deleted (locally and on `origin`) at most once an hour, from
  `start`, `done` and the session-end hook; before this, every `start` left a ref behind forever.
- **`CEASEFIRE_ALLOW_CONFLICT=1` is a self-service override**, not a
  privilege escalation: it only affects the agent's own process, and every
  use is appended to `<store>/overrides.log` (JSONL) for audit.
- **Terminal output escapes agent-supplied text.** ASCII controls are stripped;
  C1 controls, bidi overrides (Trojan Source) and zero-width characters are shown as
  `<U+XXXX>`, so `build<U+200B>er` cannot pass for `builder`.
- **PR comments** escape agent-supplied text (pipes, brackets, newlines);
  claimlock paths are shown repo-relative so machine directory layouts
  never leak into comments. The claimlock adapter opens its DB read-only
  and never writes.

## Dev

```sh
npm test    # tsc + node:test, 265 tests (hermetic: ignores GITHUB_TOKEN, stays out of the parent repo)
npx tsc     # build -> dist/
npm run bench   # accuracy (40 histories, as quoted above) + latency benchmarks (about 6 minutes)
```
