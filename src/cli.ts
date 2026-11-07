#!/usr/bin/env node
/**
 * ceasefire — parallel agents, zero merge fights. Entry point.
 *
 * node:sqlite prints an ExperimentalWarning on every load (Node 22/24).
 * Agents read ceasefire's output, so that one known warning is filtered
 * here *before* any module that imports node:sqlite is loaded. All other
 * warnings pass through unchanged.
 */
import { nodeIsSupported } from './version.js';

// package.json "engines" is only a warning for many installs: fail with a plain sentence instead of a stack trace about node:sqlite.
if (!nodeIsSupported(process.versions.node)) {
  process.stderr.write(`ceasefire: error: Node ${process.versions.node} is too old; ceasefire needs Node 22.13 or newer (it uses the built-in SQLite). Update Node, then run it again.\n`);
  process.exit(1);
}

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
