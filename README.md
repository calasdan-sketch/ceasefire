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

No daemon. No lock server. Advisory by default, strict opt-in.

## Quick start (60 seconds)

```sh
npm i -g ceasefire                 # or use `npx ceasefire ...`
cd your-repo
ceasefire init --claude            # pre-push hook + workflow stub + Claude Code hook
```

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
| `ceasefire init [--claude]` | Installs advisory pre-push hook + `.github/workflows/ceasefire.yml` stub; `--claude` also merges a PreToolUse hook into `.claude/settings.json` |
| `ceasefire check <files...> [--json]` | Pre-edit collision check |
| `ceasefire start "<task>" --paths <...> [--ttl 30m]` | Publish an intent (default 4h TTL, 1m–7d; broadcast via git refs). Paths may be files, directories or globs |
| `ceasefire done [--id <id>]` | Complete your active intent |
| `ceasefire list [--json]` | Active intents from every agent |
| `ceasefire conflicts [--json] [--exit-code]` | Collision matrix: textual (branches) + intent (agents) |
| `ceasefire conflicts --worktrees [--untracked]` | Same, across worktrees including uncommitted edits |
| `ceasefire suggest [files...] [--json]` | Unclaimed files to work on instead |
| `ceasefire hook claude [--ask]` | Claude Code PreToolUse hook (run by Claude Code, reads stdin) |
| `ceasefire --mcp` | MCP stdio server (`ceasefire_check`, `ceasefire_conflicts`) |

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
{ "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit|NotebookEdit",
  "hooks": [ { "type": "command", "command": "ceasefire hook claude", "timeout": 30 } ] } ] } }
```

`ceasefire init --claude --strict` writes a gate instead:

```json
{ "type": "command", "command": "ceasefire hook claude --strict", "timeout": 30, "onFailure": "block" }
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

### Worktree forecast details

For each worktree, ceasefire copies its index to a temp file, runs `git add -u` (or `-A`
with `--untracked`) against that copy, and writes a throwaway commit object that no ref
points at, then merges the snapshots pairwise with `git merge-tree --write-tree`.
Intent collisions in this mode use only intent refs already fetched; nothing is fetched.

What that writes, honestly:

- The content of **modified tracked files** (and, with `--untracked`, of new non-ignored
  files) is stored as unreferenced loose objects in the local object store. They are never
  pushed. `git gc` deletes them only once they are older than `gc.pruneExpire`
  (2 weeks by default).
- There is **no size cap**: `--untracked` hashes every non-ignored new file, so keep build
  output, `node_modules` and secrets in `.gitignore`.
- Clean filters run as for a normal `git add` — for example Git LFS will store LFS objects
  under `.git/lfs` for changed LFS-tracked files.
- Inherited `GIT_DIR`, `GIT_INDEX_FILE` and similar variables are removed from every git
  call ceasefire makes, so running inside a git hook cannot redirect the snapshot.

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

The blocked-agent message is written for an LLM reader: verdict first,
named holder, numbered next actions, a `ceasefire suggest` alternative, and
the `CEASEFIRE_ALLOW_CONFLICT=1` override.

## How it compares

Statements below come from each project's own README (linked); nothing here is benchmarked.

| | ceasefire | [Clash](https://github.com/clash-sh/clash) | [moire](https://github.com/jamescazzetta/moire) | [AGNT-LOCK](https://github.com/codewithriza/AGNT-LOCK) | [agent-claim-mcp](https://github.com/vk0dev/agent-claim-mcp) | [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) |
|---|---|---|---|---|---|---|
| Approach | intents + merge-tree forecast | merge-tree across worktrees | merge-tree across worktrees | file locks (MCP) | file claims (MCP) | messaging + file reservations |
| Sees uncommitted work | yes (`--worktrees`) | yes | yes | n/a | n/a | n/a |
| Declared intent before any edit | yes | no | no (by design) | yes (lock) | yes (claim) | yes (reservation) |
| Glob / directory claims | both | n/a | n/a | not documented | not documented | globs |
| Cross-machine | git refs broadcast | no | no | no (local JSON) | no (local JSON) | server |
| Claude Code hook | yes | yes | — | — | — | — |
| Can hard-block | opt-in | "ask" decision | no (warn-only by design) | yes | yes | pre-commit guard |
| Semantic (post-merge) check | not yet | no | yes, Python imports | no | no | no |

What others do better today: Clash ships a live `watch` TUI; moire runs an optional
post-merge semantic check and publishes replay measurements; mcp_agent_mail adds
agent-to-agent messaging and a web UI.

## Layout (core)

- `src/intent/` — SQLite intent store (TTL, upsert for remote intents)
- `src/forecast/` — `git merge-tree` collision engine, worktree snapshots, path canonicalization + globs
- `src/cli/` — commands, Claude Code hook, blocked-agent formatting, git-refs sync
- `src/github/`, `src/mcp/`, `src/claimlock/` — Action, MCP server, claimlock adapter

Honest limits:

- `git merge-tree` cannot see same-file *disjoint* edits (they merge cleanly). The
  intent ledger covers that case advisorially. Semantic collision detection (imports,
  duplicate symbols) is reserved as a severity but not implemented.
- `--worktrees` compares worktrees of *one* clone; agents in separate clones or on
  other machines are covered by branches + the intent broadcast instead.
- The workflow stub from `init` only forecasts the branches present in the CI checkout.
  The full PR-matrix Action lives in `src/github/` and is not yet published as a
  root-level `action.yml`, so `uses: calasdan-sketch/ceasefire@v1` does not work yet.
- Agent identity is self-asserted (see below).

## Trust model

Ceasefire coordinates **trusted-but-uncoordinated** agents. Know the boundaries:

- **Agent identity is self-asserted.** `CEASEFIRE_AGENT` (or the OS username)
  is a label, not an authentication. Any agent on the machine can publish
  intents as another agent, or complete another agent's intents with
  `ceasefire done`. Intents are advisory, so the blast radius is bad advice —
  not a security boundary. In adversarial fleets, treat the ledger as
  hints and keep `CEASEFIRE_STRICT=1` decisions human-gated.
- **Broadcast intents are validated, not trusted.** Anyone with push
  access can plant `refs/ceasefire/intents/*` refs. Fetched intents are
  shape-checked, size-capped (64KB), count-capped (500), and ids must be
  ref-safe — malformed or absurd ones are dropped, never imported.
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
npm test    # tsc + node:test, 188 tests (hermetic: ignores GITHUB_TOKEN, stays out of the parent repo)
npx tsc     # build -> dist/
```
