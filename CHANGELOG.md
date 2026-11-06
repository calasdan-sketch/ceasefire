# Changelog

## 0.2.0 — unreleased

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
- Initial release: intent ledger, merge-tree branch forecast, git-refs broadcast, MCP server,
  GitHub Action sources.
