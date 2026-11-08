// Cross-platform test runner (replaces the POSIX-only `mkdir -p … && VAR=… node --test <list>` one-liner).
// Builds, then runs every dist-test/**/*.test.js, so a new test file can no longer be forgotten in a hand-kept list.
//   node scripts/test.mjs [--no-build] [name-filter]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const args = process.argv.slice(2);
const build = !args.includes('--no-build');
const filter = args.find((a) => !a.startsWith('--'));

function run(cmd, argv, env = {}) {
  const r = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function find(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...find(p));
    else if (name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const tmp = join(root, '.test-tmp');
mkdirSync(tmp, { recursive: true });
if (build) {
  for (const argv of [[tsc], [tsc, '-p', 'tsconfig.test.json']]) {
    const code = run(process.execPath, argv);
    if (code !== 0) process.exit(code);
  }
}
const files = find(join(root, 'dist-test', 'test')).filter((f) => !filter || f.includes(filter));
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}
process.exit(run(process.execPath, ['--test', ...files], { GIT_CEILING_DIRECTORIES: tmp, CEASEFIRE_TEST_TMP: tmp }));
