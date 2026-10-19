/**
 * PR comment renderer for ceasefire's GitHub Action.
 *
 * Human-facing collision matrix: a verdict-first summary, a compact table,
 * plain-language explanations per severity with concrete next steps, and
 * re-run instructions. Never a wall of JSON.
 */
import type { ClaimSignal, Collision, CollisionSeverity, OpenPR, Verdict } from './types.js';

export const COMMENT_MARKER = '<!-- ceasefire-collision-matrix -->';

export interface CommentInput {
  prs: OpenPR[];
  collisions: Collision[];
  verdict: Verdict;
  claimSignals?: ClaimSignal[];
  /** e.g. "acme/repo" — shown for context. */
  repoFullName?: string;
  /** Short SHA of the head commit that triggered this forecast. */
  triggerSha?: string;
  /** URL of the workflow run, for drill-down. */
  runUrl?: string;
}

/** Any textual collision means a merge would actually conflict -> block. Otherwise advisory. */
export function deriveVerdict(collisions: Collision[]): Verdict {
  if (collisions.length === 0) return 'clear';
  return collisions.some((c) => c.severity === 'textual') ? 'blocked' : 'advisory';
}

const SEVERITY_RANK: Record<CollisionSeverity, number> = { textual: 0, intent: 1, semantic: 2 };

function severityLabel(s: CollisionSeverity): string {
  switch (s) {
    case 'textual': return '🔴 Textual';
    case 'intent': return '🟡 Intent';
    case 'semantic': return '🟣 Semantic';
  }
}

function verdictLine(v: Verdict): string {
  switch (v) {
    case 'clear': return '✅ Clear';
    case 'advisory': return '⚠️ Advisory';
    case 'blocked': return '🛑 Blocked';
  }
}

/** Escape a value for use inside a Markdown table cell: pipes would break
 *  the cell structure, newlines would break the row. Brackets are escaped
 *  too — agent names and claim notes are agent-supplied, and an unescaped
 *  `[x](https://…)` inside `**…**` could inject a link into the comment.
 *  Backticks are left alone — they only affect inline-code rendering,
 *  never table structure. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\s+/g, ' ').trim();
}

/** Inline code span safe for body text (no table). */
function code(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`';
}

function shortFiles(files: string[]): string {
  if (files.length === 0) return '—';
  const shown = files.slice(0, 6).map((f) => code(f)).join(', ');
  return files.length > 6 ? `${shown}, +${files.length - 6} more` : shown;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

const EXPLAINERS: Record<CollisionSeverity, { what: string; next: string }> = {
  textual: {
    what: 'Git predicts a **real merge conflict** here — merging either branch will stop at these files until someone resolves it by hand.',
    next: 'Rebase one branch onto the other and resolve locally, or get the two authors to agree on a merge order in the PR thread.',
  },
  intent: {
    what: 'Two agents are working the **same area at the same time**. The file lists differ, but the changes may overlap logically — renames, refactors, or API changes the other side assumes.',
    next: 'Skim the other PR\u2019s diff before merging. If it touches the same functions, coordinate in the PR thread first.',
  },
  semantic: {
    what: 'No textual conflict, but the changes may **interact** — duplicate symbols, conflicting imports, or behavior changes the other branch depends on.',
    next: 'Review both diffs together. Consider merging one first, then re-running CI on the other before it lands.',
  },
};

export function renderCollisionComment(input: CommentInput): string {
  const { prs, verdict } = input;
  const collisions = [...input.collisions].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const draftCount = prs.filter((p) => p.isDraft).length;

  const lines: string[] = [];
  lines.push('## 🤝 Ceasefire collision forecast');
  lines.push('');

  // --- verdict-first summary ---
  let summary = `**Verdict: ${verdictLine(verdict)}**`;
  if (verdict === 'clear') {
    summary += ` — no collisions forecast across ${prs.length} open PR${prs.length === 1 ? '' : 's'}.`;
  } else {
    const n = collisions.length;
    summary += ` — ${n} potential collision${n === 1 ? '' : 's'} across ${prs.length} open PR${prs.length === 1 ? '' : 's'}`;
    if (draftCount > 0) summary += ` (${draftCount} draft)`;
    summary += '.';
  }
  if (input.triggerSha !== undefined && input.triggerSha !== '') {
    summary += ` Forecast for ${code(input.triggerSha.slice(0, 7))}.`;
  }
  if (input.runUrl !== undefined && input.runUrl !== '') {
    summary += ` · [workflow run](${input.runUrl})`;
  }
  lines.push(summary);
  if (input.repoFullName !== undefined && input.repoFullName !== '') {
    lines.push(`<sub>${cell(input.repoFullName)}</sub>`);
  }
  lines.push('');
  lines.push('> Ceasefire is **advisory in v1** — nothing here blocks a merge automatically. Treat 🔴 rows as “talk before merging”.');
  lines.push('');

  if (verdict === 'clear' && (input.claimSignals ?? []).length === 0) {
    lines.push('No textual, intent, or semantic collisions detected. Safe to proceed — ceasefire re-forecasts on every PR event.');
    lines.push('');
    lines.push(rerunSection());
    lines.push('');
    lines.push(COMMENT_MARKER);
    return lines.join('\n');
  }

  // --- collision matrix table ---
  if (collisions.length > 0) {
    lines.push('### Collision matrix');
    lines.push('');
    lines.push('| PRs | Severity | Files at risk |');
    lines.push('|-----|----------|---------------|');
    for (const c of collisions) {
      lines.push(`| ${cell(c.prA)} ↔ ${cell(c.prB)} | ${severityLabel(c.severity)} | ${cell(shortFiles(c.files))} |`);
    }
    lines.push('');

    // --- per-severity explanations, grouped ---
    lines.push('### What this means');
    lines.push('');
    const bySeverity = new Map<CollisionSeverity, Collision[]>();
    for (const c of collisions) {
      const list = bySeverity.get(c.severity) ?? [];
      list.push(c);
      bySeverity.set(c.severity, list);
    }
    const ordered = [...bySeverity.entries()].sort((a, b) => SEVERITY_RANK[a[0]] - SEVERITY_RANK[b[0]]);
    for (const [sev, group] of ordered) {
      const expl = EXPLAINERS[sev];
      lines.push(`#### ${severityLabel(sev)}`);
      lines.push('');
      lines.push(expl.what);
      lines.push('');
      for (const c of group) {
        lines.push(`- **${cell(c.prA)}** ↔ **${cell(c.prB)}**: ${shortFiles(c.files)}`);
      }
      lines.push('');
      lines.push(`**Next step:** ${expl.next}`);
      lines.push('');
    }
  }

  // --- claimlock advisory signals ---
  const signals = input.claimSignals ?? [];
  if (signals.length > 0) {
    lines.push('### 🛰️ Path claims (claimlock)');
    lines.push('');
    lines.push('Heads-up — another agent holds a live path claim (advisory only, expires automatically):');
    lines.push('');
    for (const s of signals) {
      // Claim notes are free-form agent text: truncate so one hostile or
      // chatty note cannot blow up the comment size.
      const note = s.note !== '' ? ` — “${cell(s.note.slice(0, 200))}”` : '';
      lines.push(`- ${code(s.path)} — claimed by **${cell(s.holder)}**${note} (expires in ${formatDuration(s.expiresInSec)})`);
    }
    lines.push('');
  }

  lines.push(rerunSection());
  lines.push('');
  lines.push('<sub>Posted by ceasefire — collision forecasting for parallel agents. Forecasts are heuristic; always review before merging.</sub>');
  lines.push(COMMENT_MARKER);
  return lines.join('\n');
}

function rerunSection(): string {
  return [
    '---',
    '**Re-run:** push new commits and ceasefire re-forecasts automatically. Or comment `/ceasefire rerun` on this PR (needs the `issue_comment` trigger in `.github/workflows/ceasefire.yml`).',
  ].join('\n');
}
