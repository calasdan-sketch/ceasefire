/**
 * Blocked-agent output format.
 *
 * This is read by an LLM, not a human. Rules:
 * - Verdict first, on the very first line.
 * - Name the holder (agent, branch, intent id, task, expiry).
 * - Numbered next actions, concrete commands.
 * - Always point at `ceasefire suggest` for a productive alternative.
 * - Always document the CEASEFIRE_ALLOW_CONFLICT=1 override.
 */
import type { Verdict } from '../types.js';

/**
 * Strip ASCII control characters from agent-supplied text before printing.
 * Intent fields (task, agent, branch) can originate from *another* agent's
 * machine via the git-refs broadcast; printing them raw would let a
 * hostile or buggy agent inject terminal escape sequences (title changes,
 * colors, OSC-52 clipboard reads, …) into whoever runs `ceasefire check`.
 * JSON output is unaffected (JSON.stringify escapes control chars).
 */
export function sanitizeDisplay(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(INVISIBLE_RE, (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/**
 * C1 controls (U+0080-U+009F, e.g. the 8-bit CSI U+009B that some terminals
 * honour), bidi overrides/isolates (Trojan Source, CVE-2021-42574),
 * zero-width and other invisible format characters, and line/paragraph
 * separators. These are made *visible* rather than stripped: an agent named
 * "hermes<U+200B>" must not display as a convincing "hermes".
 */
const INVISIBLE_RE = /[\u0080-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;

export interface Contention {
  holder: string;
  branch: string;
  intentId: string;
  task: string;
  /** ms until the intent lapses. */
  expiresInMs: number;
  /** The checked files this intent overlaps. */
  files: string[];
}

export interface CheckReport {
  verdict: Verdict;
  files: string[];
  contentions: Contention[];
  /** True when the caller explicitly accepted the risk. */
  overridden: boolean;
  /** True when CEASEFIRE_STRICT=1 escalated advisory -> blocked. */
  strict: boolean;
}

/** "3h 12m", "45m", "expired". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatBlockedMessage(report: CheckReport): string {
  const lines: string[] = [];
  if (report.verdict === 'blocked') {
    lines.push('CEASEFIRE VERDICT: BLOCKED — hard block (CEASEFIRE_STRICT=1 is set).');
  } else {
    lines.push('CEASEFIRE VERDICT: ADVISORY — another agent is actively working on these files.');
  }
  lines.push(
    'You are about to edit files that another agent has an active intent on. ' +
      'Editing them now risks a merge conflict you will have to resolve by hand.',
  );
  lines.push('');
  for (const c of report.contentions) {
    lines.push(
      `Holder: agent "${sanitizeDisplay(c.holder)}" (branch ${sanitizeDisplay(c.branch)}, intent ${c.intentId.slice(0, 8)} — "${sanitizeDisplay(c.task)}", expires in ${formatDuration(c.expiresInMs)})`,
    );
    lines.push('Files in contention:');
    lines.push(...listFiles(c.files, '\n').split('\n').map((f) => `  - ${f}`));
    lines.push('');
  }
  lines.push('Recommended next actions:');
  lines.push('  1. Pick different files: run `ceasefire suggest` for unclaimed alternatives you can work on now.');
  const holders = [...new Set(report.contentions.map((c) => c.holder))].map((h) => `"${sanitizeDisplay(h)}"`).join(', ');
  lines.push(`  2. Coordinate with the holder (${holders}) before touching these files.`);
  lines.push('  3. Wait for the holder to release the intent (`ceasefire done`), or for it to expire.');
  lines.push(
    '  4. Override only if you accept the merge-conflict risk: re-run with CEASEFIRE_ALLOW_CONFLICT=1.',
  );
  return lines.join('\n');
}

/** Names shown in one message. `check --stdin` can be fed tens of thousands of files, and an agent reads every byte of the answer. */
export const MAX_LISTED_FILES = 20;

function listFiles(files: string[], sep: string): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map(sanitizeDisplay);
  const more = files.length - shown.length;
  return shown.join(sep) + (more > 0 ? `${sep}… and ${more} more` : '');
}

export function formatClearMessage(files: string[]): string {
  return `ceasefire: clear — no active intent overlaps ${files.length === 1 ? 'this file' : 'these files'}: ${listFiles(files, ', ')}`;
}

export function formatOverrideMessage(files: string[]): string {
  return (
    `ceasefire: proceeding with CEASEFIRE_ALLOW_CONFLICT=1 — you accepted the merge-conflict risk on: ${listFiles(files, ', ')}. ` +
    'Run `ceasefire suggest` if you would rather work on unclaimed files.'
  );
}
