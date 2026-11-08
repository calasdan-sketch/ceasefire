// Mutation-style sanity check: break one key condition at a time in a COPY of the build and confirm the tests notice.
// A mutant that survives means a test is missing. Usage: npm run build && node scripts/mutation-check.mjs
// Optional argument: only mutants whose name contains it. Needs `npm run build` and `tsc -p tsconfig.test.json` first (npm test does both). Never touches the real dist/.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// [name, file under dist/, text to find, replacement, test files expected to notice (under dist-test/test/)]
const MUTANTS = [
  ['dir/file conflict suffix kept', 'forecast/batch.js', 'return p.replace(/~[0-9a-f]{40}(?:[0-9a-f]{24})?$/, \'\');', 'return p;', ['round5.test.js']],
  ['sibling folder counted as inside the repo', 'forecast/paths.js', "c.startsWith(r + '/')", 'c.startsWith(r)', ['paths.test.js', 'round5.test.js']],
  ['git octal quoting decoded as decimal', 'cli/gitquote.js', 'parseInt(m[0], 8)', 'parseInt(m[0], 10)', ['round4.test.js', 'round5.test.js']],
  ['advisory exit code is 0', 'types.js', 'export const EXIT_ADVISORY = 2;', 'export const EXIT_ADVISORY = 0;', ['cli.test.js', 'hardening.test.js']],
  ['Node gate off by one', 'version.js', 'minor >= 13', 'minor > 13', ['round4.test.js']],
  ['clean merge with paths accepted by batch parser', 'forecast/batch.js', "status === '1' && files.length > 0", 'false', ['round3.test.js', 'expert2.test.js', 'forecast.test.js']],
  ['merge-tree failure treated as no conflict', 'forecast/forecast.js', 'result.exitCode !== 0 && result.exitCode !== 1', 'false', ['forecast.test.js', 'round3.test.js', 'round5.test.js']],
  ['default intent lifetime is 0', 'intent/store.js', 'export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;', 'export const DEFAULT_TTL_MS = 1;', ['intent.test.js', 'cli.test.js']],
  ['truncated merge-tree stream accepted as complete', 'forecast/batch.js', 'if (j + 1 >= tokens.length)', 'if (j >= tokens.length)', ['round5.test.js']],
  ['glob star no longer a wildcard', 'forecast/paths.js', "if (c === '*' || c === '?' || c === '[')", "if (c === '?' || c === '[')", ['paths.test.js', 'round5.test.js']],
  ['own intents warn their owner', 'cli/commands.js', 'if (intent.agent === agent)', 'if (false)', ['cli.test.js', 'expert2.test.js', 'round3.test.js']],
];

const dir = mkdtempSync(join(tmpdir(), 'cf-mutate-'));
let survived = 0;
let ran = 0;
try {
  for (const d of ['dist', 'dist-test', 'scripts', join('test', 'golden')]) if (existsSync(join(root, d))) cpSync(join(root, d), join(dir, d), { recursive: true });
  for (const f of ['package.json', 'LICENSE', 'CHANGELOG.md', '.gitattributes']) cpSync(join(root, f), join(dir, f));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const only = process.argv[2];
  for (const [name, file, from, to, tests] of MUTANTS) {
    if (only && !name.includes(only)) continue;
    const targets = [join(dir, 'dist', file), join(dir, 'dist-test', 'src', file)];
    const orig = targets.map((t) => readFileSync(t, 'utf8'));
    if (!orig[0].includes(from)) { console.error(`mutant "${name}": text not found in dist/${file}; the script is out of date`); process.exit(2); }
    targets.forEach((t, i) => writeFileSync(t, orig[i].split(from).join(to)));
    const r = spawnSync(process.execPath, ['--test', ...tests.map((t) => join(dir, 'dist-test', 'test', t))], { cwd: dir, encoding: 'utf8', env: { ...process.env, CEASEFIRE_SYNC: '0', GIT_CEILING_DIRECTORIES: tmpdir() } });
    ran++;
    const killed = r.status !== 0;
    if (!killed) survived++;
    console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${name}`);
    targets.forEach((t, i) => writeFileSync(t, orig[i]));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(survived === 0 ? `all ${ran} mutant(s) killed` : `${survived} mutant(s) survived: add a test`);
process.exit(survived === 0 ? 0 : 1);
