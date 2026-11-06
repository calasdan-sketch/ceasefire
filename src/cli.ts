#!/usr/bin/env node
/**
 * ceasefire — parallel agents, zero merge fights. Entry point.
 *
 * node:sqlite prints an ExperimentalWarning on every load (Node 22/24).
 * Agents read ceasefire's output, so that one known warning is filtered
 * here *before* any module that imports node:sqlite is loaded. All other
 * warnings pass through unchanged.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type =
    typeof rest[0] === 'string'
      ? rest[0]
      : typeof rest[0] === 'object' && rest[0] !== null
        ? (rest[0] as { type?: string }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await import('./cli/main.js');
