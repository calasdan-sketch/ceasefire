/**
 * CLI command implementations. Each returns a CommandResult; the entry
 * point (src/cli.ts) only handles argv parsing and process exit codes.
 * Keeping commands pure-ish makes them testable without spawning.
 */
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, renameSync, appendFileSync } from 'node:fs';
import { IntentStore, resolveDbPath, resolveStoreDir, openIntentStore } from '../intent/index.js';
import { pathsOverlap, normalizePath, buildCollisionMatrix } from '../forecast/forecast.js';
import { findGitRoot, currentBranch, listLocalBranches, git, CeasefireGitError } from '../forecast/git.js';
import { broadcastIntent, fetchRemoteIntents } from './sync.js';
import {
  formatBlockedMessage,
  formatClearMessage,
  formatOverrideMessage,
  formatDuration,
  sanitizeDisplay,
  type Contention,
  type CheckReport,
} from './format.js';
import { EXIT_CLEAR, EXIT_ERROR, EXIT_ADVISORY, EXIT_BLOCKED, type Intent, type Verdict } from '../types.js';

export interface Ctx {
  cwd: string;
  /** True when --json was passed or CEASEFIRE_JSON=1 is set. */
  json: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

const HOOK_MARKER = '# installed by ceasefire init';
const WORKFLOW_MARKER = '# installed by ceasefire init';

export function currentAgent(): string {
  const fromEnv = process.env.CEASEFIRE_AGENT?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function currentBranchName(cwd: string): string {
  return process.env.CEASEFIRE_BRANCH?.trim() || currentBranch(cwd) || 'unknown';
}

function openStore(cwd: string): IntentStore {
  // Resilient open: a corrupt intents.db is quarantined and recreated
  // instead of failing every command (see openIntentStore).
  return openIntentStore(resolveDbPath(cwd));
}

/**
 * Record a CEASEFIRE_ALLOW_CONFLICT=1 override as JSONL in the store dir.
 * Overrides are the telemetry the DX review asked for: they show up as
 * "override rate", the metric for whether strict mode should ever become
 * the default. Best-effort — logging must never break the check itself.
 */
function logOverride(cwd: string, agent: string, files: string[], contentions: Contention[]): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      files,
      holders: [...new Set(contentions.map((c) => c.holder))],
    });
    appendFileSync(join(resolveStoreDir(cwd), 'overrides.log'), line + '\n');
  } catch {
    /* logging is advisory */
  }
}

/** Local active intents plus best-effort remote ones, deduped by id. */
export function allActiveIntents(cwd: string, store: IntentStore, now: number): Intent[] {
  const local = store.list({ status: 'active', now });
  const seen = new Set(local.map((i) => i.id));
  const merged = [...local];
  for (const remote of fetchRemoteIntents(cwd)) {
    if (!seen.has(remote.id) && remote.status === 'active' && remote.expiresAt > now) {
      seen.add(remote.id);
      merged.push(remote);
    }
  }
  return merged;
}

function err(message: string): CommandResult {
  return { exitCode: EXIT_ERROR, stdout: '', stderr: `ceasefire: error: ${message}\n` };
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

export function cmdCheck(ctx: Ctx, files: string[], now: number = Date.now()): CommandResult {
  if (files.length === 0) return err('usage: ceasefire check <file> [<file>...] [--json]');
  const normalized = [...new Set(files.map(normalizePath).filter(Boolean))];
  if (normalized.length === 0) return err('usage: ceasefire check <file> [<file>...] [--json]');

  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const contentions: Contention[] = [];
    for (const intent of allActiveIntents(ctx.cwd, store, now)) {
      if (intent.agent === agent) continue; // your own intents never block you
      const overlapping = normalized.filter((f) => intent.paths.some((p) => pathsOverlap(f, p)));
      if (overlapping.length > 0) {
        contentions.push({
          holder: intent.agent,
          branch: intent.branch,
          intentId: intent.id,
          task: intent.task,
          expiresInMs: intent.expiresAt - now,
          files: overlapping.sort(),
        });
      }
    }

    if (contentions.length === 0) {
      const message = formatClearMessage(normalized);
      return {
        exitCode: EXIT_CLEAR,
        stdout: ctx.json
          ? JSON.stringify({ verdict: 'clear', files: normalized, contentions: [], message }, null, 2) + '\n'
          : message + '\n',
      };
    }

    if (process.env.CEASEFIRE_ALLOW_CONFLICT === '1') {
      const message = formatOverrideMessage(normalized);
      logOverride(ctx.cwd, agent, normalized, contentions);
      const report: CheckReport = { verdict: 'clear', files: normalized, contentions, overridden: true, strict: false };
      return {
        exitCode: EXIT_CLEAR,
        stdout: ctx.json
          ? JSON.stringify({ ...report, message }, null, 2) + '\n'
          : message + '\n',
      };
    }

    const strict = process.env.CEASEFIRE_STRICT === '1';
    const verdict: Verdict = strict ? 'blocked' : 'advisory';
    const report: CheckReport = { verdict, files: normalized, contentions, overridden: false, strict };
    const message = formatBlockedMessage(report);
    return {
      exitCode: strict ? EXIT_BLOCKED : EXIT_ADVISORY,
      stdout: ctx.json
        ? JSON.stringify({ ...report, message }, null, 2) + '\n'
        : message + '\n',
    };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* start / done                                                        */
/* ------------------------------------------------------------------ */

export function cmdStart(ctx: Ctx, task: string, paths: string[]): CommandResult {
  if (!task.trim()) return err('usage: ceasefire start "<task>" --paths <file> [<file>...]');
  const store = openStore(ctx.cwd);
  try {
    const intent = store.publish(task, paths, {
      agent: currentAgent(),
      branch: currentBranchName(ctx.cwd),
    });
    broadcastIntent(ctx.cwd, intent); // best-effort, never throws
    const line =
      `ceasefire: intent ${intent.id.slice(0, 8)} published by "${sanitizeDisplay(intent.agent)}" on ${sanitizeDisplay(intent.branch)} ` +
      `(expires in ${formatDuration(intent.expiresAt - Date.now())}). Release with \`ceasefire done\`.`;
    return {
      exitCode: EXIT_CLEAR,
      stdout: ctx.json ? JSON.stringify({ intent }, null, 2) + '\n' : line + '\n',
    };
  } catch (e) {
    return err(e instanceof Error ? e.message.replace(/^ceasefire: /, '') : String(e));
  } finally {
    store.close();
  }
}

export function cmdDone(ctx: Ctx, id?: string, now: number = Date.now()): CommandResult {
  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const mine = allActiveIntents(ctx.cwd, store, now).filter((i) => i.agent === agent);
    if (mine.length === 0) {
      return err(`no active intent for agent "${agent}" on this machine. Nothing to complete.`);
    }
    let target: Intent;
    if (id) {
      const matches = mine.filter((i) => i.id === id || i.id.startsWith(id));
      if (matches.length === 0) return err(`no active intent for agent "${agent}" matching "${id}".`);
      if (matches.length > 1) {
        const list = matches.map((i) => `  ${i.id.slice(0, 8)}  ${i.branch}  "${i.task}"`).join('\n');
        return err(
          `"${id}" matches ${matches.length} active intents; be more specific:\n${list}\nUse: ceasefire done --id <id>`,
        );
      }
      const found = matches[0] as Intent;
      target = found;
    } else if (mine.length > 1) {
      const list = mine.map((i) => `  ${i.id.slice(0, 8)}  ${i.branch}  "${i.task}"`).join('\n');
      return err(
        `agent "${agent}" has ${mine.length} active intents; specify one:\n${list}\nUse: ceasefire done --id <id>`,
      );
    } else {
      const only = mine[0];
      if (!only) return err(`no active intent for agent "${agent}" on this machine. Nothing to complete.`);
      target = only;
    }
    // The intent may live only in a git-refs broadcast from another machine.
    // Import it locally first so the completion sticks and is re-broadcast.
    if (!store.get(target.id)) store.upsert(target);
    const updated = store.complete(target.id);
    if (updated) broadcastIntent(ctx.cwd, updated); // best-effort, never throws
    const line = `ceasefire: intent ${target.id.slice(0, 8)} ("${sanitizeDisplay(target.task)}") completed.`;
    return {
      exitCode: EXIT_CLEAR,
      stdout: ctx.json ? JSON.stringify({ completed: updated ?? target }, null, 2) + '\n' : line + '\n',
    };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* conflicts                                                           */
/* ------------------------------------------------------------------ */

export function cmdConflicts(ctx: Ctx, now: number = Date.now()): CommandResult {
  const root = findGitRoot(ctx.cwd);
  if (!root) return err('not a git repository. `ceasefire conflicts` forecasts branch collisions with git merge-tree.');
  let branches: string[];
  try {
    branches = listLocalBranches(ctx.cwd);
  } catch (e) {
    return err(e instanceof CeasefireGitError ? e.stderr : String(e));
  }
  const store = openStore(ctx.cwd);
  try {
    const intents = allActiveIntents(ctx.cwd, store, now);
    const skipped: string[] = [];
    const collisions = buildCollisionMatrix(ctx.cwd, branches, intents, now, (a, b, reason) => {
      skipped.push(`ceasefire: warning — could not forecast ${a} <-> ${b}: ${reason}`);
    });
    const stderr = skipped.length > 0 ? skipped.join('\n') + '\n' : undefined;
    if (ctx.json) {
      return {
        exitCode: EXIT_CLEAR,
        stdout: JSON.stringify({ branches, collisionCount: collisions.length, collisions, generatedAt: now }, null, 2) + '\n',
        ...(stderr !== undefined ? { stderr } : {}),
      };
    }
    if (collisions.length === 0) {
      return {
        exitCode: EXIT_CLEAR,
        stdout: `ceasefire: no collisions across ${branches.length} branch(es).\n`,
        ...(stderr !== undefined ? { stderr } : {}),
      };
    }
    const lines = [
      `ceasefire: ${collisions.length} collision(s) across ${branches.length} branch(es):`,
      ...collisions.map(
        (c) =>
          `  [${c.severity.toUpperCase()}] ${sanitizeDisplay(c.prA)} <-> ${sanitizeDisplay(c.prB)}\n` +
          `      files: ${c.files.map(sanitizeDisplay).join(', ')}` +
          (c.detail ? `\n      ${sanitizeDisplay(c.detail)}` : ''),
      ),
    ];
    return { exitCode: EXIT_CLEAR, stdout: lines.join('\n') + '\n', ...(stderr !== undefined ? { stderr } : {}) };
  } catch (e) {
    return err(e instanceof CeasefireGitError ? e.stderr : String(e));
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* suggest                                                             */
/* ------------------------------------------------------------------ */

/** Tracked files nobody holds an active intent on (capped). Never throws. */
function unclaimedFiles(cwd: string, intents: Intent[], limit = 15): string[] {
  const root = findGitRoot(cwd);
  if (!root) return [];
  let tracked: string[];
  try {
    tracked = git(cwd, ['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const claimed = intents.filter((i) => i.status === 'active');
  return tracked
    .filter((f) => !claimed.some((i) => i.paths.some((p) => pathsOverlap(f, p))))
    .slice(0, limit);
}

export function cmdSuggest(ctx: Ctx, files: string[], now: number = Date.now()): CommandResult {
  const agent = currentAgent();
  const store = openStore(ctx.cwd);
  try {
    const intents = allActiveIntents(ctx.cwd, store, now).filter((i) => i.agent !== agent);
    const normalized = [...new Set(files.map(normalizePath).filter(Boolean))];
    const holders = new Map<string, { holder: string; task: string }>();
    for (const f of normalized) {
      for (const intent of intents) {
        if (intent.paths.some((p) => pathsOverlap(f, p))) {
          holders.set(f, { holder: intent.agent, task: intent.task });
        }
      }
    }
    const alternatives = unclaimedFiles(ctx.cwd, intents);

    if (ctx.json) {
      return {
        exitCode: EXIT_CLEAR,
        stdout:
          JSON.stringify(
            {
              blockedFiles: [...holders.entries()].map(([file, h]) => ({ file, ...h })),
              alternatives,
            },
            null,
            2,
          ) + '\n',
      };
    }

    const lines: string[] = [];
    if (holders.size === 0) {
      lines.push(
        normalized.length > 0
          ? 'ceasefire suggest: nothing holds those files — proceed with `ceasefire check` to confirm.'
          : 'ceasefire suggest: no active intents from other agents right now.',
      );
    } else {
      lines.push('ceasefire suggest: these files are held by other agents — work around them:');
      for (const [file, h] of holders) {
        lines.push(`  - ${file}  (held by "${h.holder}" — "${h.task}")`);
      }
    }
    if (alternatives.length > 0) {
      lines.push('');
      lines.push('Productive alternatives nobody has claimed:');
      for (const a of alternatives) lines.push(`  - ${a}`);
    } else if (holders.size > 0) {
      lines.push('');
      lines.push('No unclaimed tracked files found; coordinate with the holders above or wait for `ceasefire done`.');
    }
    return { exitCode: EXIT_CLEAR, stdout: lines.join('\n') + '\n' };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

const PRE_PUSH_HOOK = `#!/bin/sh
${HOOK_MARKER} — advisory only, never blocks a push.
# Runs a collision forecast before push. Best-effort: if ceasefire is missing
# or the forecast fails, the push continues.
#
# Skips ceasefire's own intent-broadcast pushes (refs/ceasefire/*): every
# \`ceasefire start\`/\`ceasefire done\` pushes an intent ref, and forecasting the
# whole repo on each of those would be pure overhead.
seen=0
only_ceasefire=1
while read -r _ _ remote _; do
  seen=1
  case "$remote" in
    refs/ceasefire/*) ;;
    *) only_ceasefire=0; break ;;
  esac
done
if [ "$seen" = 1 ] && [ "$only_ceasefire" = 1 ]; then
  exit 0
fi
if command -v ceasefire >/dev/null 2>&1; then
  if out=$(ceasefire conflicts 2>/dev/null); then
    case "$out" in
      *'collision(s)'*)
        printf 'ceasefire: pre-push collision forecast (advisory — push continues)\\n%s\\n' "$out" >&2
        ;;
    esac
  else
    printf 'ceasefire: collision forecast failed (advisory — push continues)\\n' >&2
  fi
fi
exit 0
`;

const WORKFLOW_STUB = `${WORKFLOW_MARKER}: advisory collision forecast (full PR comments by the ceasefire GitHub Action)
name: ceasefire
on:
  pull_request:
jobs:
  forecast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx ceasefire@latest conflicts --json
`;

export function cmdInit(ctx: Ctx): CommandResult {
  const root = findGitRoot(ctx.cwd);
  if (!root) return err('not a git repository. Run `ceasefire init` inside a git checkout.');
  let gitDir: string;
  try {
    gitDir = git(ctx.cwd, ['rev-parse', '--absolute-git-dir']);
  } catch (e) {
    return err(e instanceof CeasefireGitError ? e.stderr : String(e));
  }

  const notes: string[] = [];

  // Pre-push hook (advisory, never blocks).
  const hookPath = join(gitDir, 'hooks', 'pre-push');
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER)) {
      const backup = `${hookPath}.ceasefire-backup`;
      renameSync(hookPath, backup);
      notes.push(`existing pre-push hook backed up to ${backup}`);
    } else {
      notes.push('pre-push hook already installed by ceasefire; refreshed');
    }
  }
  writeFileSync(hookPath, PRE_PUSH_HOOK, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  notes.push(`pre-push hook installed at ${hookPath} (advisory only, never blocks)`);

  // GitHub workflow stub.
  const wfPath = join(root, '.github', 'workflows', 'ceasefire.yml');
  if (existsSync(wfPath)) {
    const existing = readFileSync(wfPath, 'utf8');
    notes.push(
      existing.includes(WORKFLOW_MARKER)
        ? 'workflow stub already present; left untouched'
        : 'workflow ceasefire.yml already exists and was not created by ceasefire; left untouched',
    );
  } else {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(wfPath, WORKFLOW_STUB);
    notes.push(`workflow stub written to ${wfPath}`);
  }

  // The intent DB is local agent state (plus WAL sidecars) — it must never
  // be committed. Ignore the whole .ceasefire/ dir.
  const giPath = join(root, '.gitignore');
  const giLine = '.ceasefire/';
  if (existsSync(giPath)) {
    const lines = readFileSync(giPath, 'utf8').split('\n').map((l) => l.trim());
    if (!lines.includes(giLine) && !lines.includes('.ceasefire')) {
      appendFileSync(giPath, `\n${giLine}\n`);
      notes.push('added .ceasefire/ to .gitignore (intent DB is local state, never committed)');
    } else {
      notes.push('.gitignore already covers .ceasefire/');
    }
  } else {
    writeFileSync(giPath, `${giLine}\n`);
    notes.push('created .gitignore ignoring .ceasefire/ (intent DB is local state, never committed)');
  }

  notes.push('agents: add `ceasefire check <files>` before editing shared files (1 line in AGENTS.md)');
  const body = notes.map((n) => `  - ${n}`).join('\n');
  return {
    exitCode: EXIT_CLEAR,
    stdout: ctx.json
      ? JSON.stringify({ initialized: true, notes }, null, 2) + '\n'
      : `ceasefire: initialized in ${root}\n${body}\n`,
  };
}
