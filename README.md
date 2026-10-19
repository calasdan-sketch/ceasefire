# ceasefire — parallel agents, zero merge fights

`ceasefire` keeps parallel AI agents from stepping on each other's files. Two
mechanisms:

1. **Intent ledger** — agents publish soft, expiring, *advisory* intents
   ("I'm about to work on these paths"). `ceasefire check` warns before you
   edit files another agent holds. Intents never block; only information.
2. **Merge-tree forecast** — `ceasefire conflicts` runs `git merge-tree`
   pairwise across local branches and reports textual collisions before
   anyone pushes.

No daemon. No lock server. Advisory by default, strict opt-in.

## Install

```sh
npx ceasefire init        # pre-push hook (advisory) + GitHub workflow stub
```

Zero runtime dependencies — SQLite via `node:sqlite` (built-in since
Node 22), tests via `node:test`. Requires Node >= 22 and git
(git >= 2.38 for full rename/binary conflict detection; older gits fall
back to a legacy parser without rename detection).

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
| `ceasefire init` | Installs advisory pre-push hook + `.github/workflows/ceasefire.yml` stub |
| `ceasefire check <files...> [--json]` | Pre-edit collision check |
| `ceasefire start "<task>" --paths <...>` | Publish an intent (4h TTL, broadcast via git refs) |
| `ceasefire done [--id <id>]` | Complete your active intent |
| `ceasefire conflicts [--json]` | Collision matrix: textual (branches) + intent (agents) |
| `ceasefire suggest [files...] [--json]` | Unclaimed files to work on instead |

Exit codes: `0` clear · `1` error · `2` advisory · `3` hard block.

## Environment

| Var | Effect |
|---|---|
| `CEASEFIRE_JSON=1` | Force JSON output |
| `CEASEFIRE_STRICT=1` | Advisory becomes a hard block (exit 3) |
| `CEASEFIRE_ALLOW_CONFLICT=1` | Proceed anyway (exit 0, risk accepted) |
| `CEASEFIRE_AGENT=<name>` | Agent identity (default: OS username) |
| `CEASEFIRE_DIR=<dir>` | Intent store location |
| `CEASEFIRE_SYNC=0` | Disable git-refs broadcast |

The blocked-agent message is written for an LLM reader: verdict first,
named holder, numbered next actions, a `ceasefire suggest` alternative, and
the `CEASEFIRE_ALLOW_CONFLICT=1` override.

## Layout (core)

- `src/intent/` — SQLite intent store (TTL, upsert for remote intents)
- `src/forecast/` — `git merge-tree` collision engine + intent overlap
- `src/cli/` — commands, blocked-agent formatting, git-refs sync
- `src/github/`, `src/mcp/`, `src/claimlock/` — owned by the Action/MCP worker

Known limitation: `git merge-tree` cannot see same-file *disjoint* edits
(they merge cleanly). The intent ledger covers that case advisorially —
which is exactly what `ceasefire check` is for. Semantic collision detection
(imports, duplicate symbols) is stubbed as a severity for v1.1.

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
- **PR comments** escape agent-supplied text (pipes, brackets, newlines);
  claimlock paths are shown repo-relative so machine directory layouts
  never leak into comments. The claimlock adapter opens its DB read-only
  and never writes.

## Dev

```sh
npm test    # tsc + node:test, 139 tests
npx tsc     # build -> dist/
```
