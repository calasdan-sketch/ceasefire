// Latency benchmarks:  node bench/latency.mjs [--json] [--runs 25]
//  1. all-pairs branch forecast, N = 10/20/40 branches: one git process per pair (0.2) vs batched --stdin
//  2. --deep forecast cost on the same branches
//  3. editor-hook latency (whole process, as Claude Code runs it): plain, with auto-lease, with 200 intents in the ledger
//  4. optional: Clash (https://github.com/clash-sh/clash) on the same worktrees, if CLASH_BIN or `clash` is on PATH
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, rng, baseFiles, initRepo, cleanup, tmp } from './lib.mjs';

const JSON_OUT = process.argv.includes('--json');
const RUNS = (() => { const i = process.argv.indexOf('--runs'); return i > 0 ? Number(process.argv[i + 1]) : 25; })();
const root = new URL('../dist/', import.meta.url);
const CLI = new URL('cli.js', root).pathname;
const { textualCollisions } = await import(new URL('forecast/forecast.js', root));
const { deepForecast } = await import(new URL('forecast/deep.js', root));
const { IntentStore } = await import(new URL('intent/store.js', root));
const { mergeTreeBatch } = await import(new URL('forecast/batch.js', root));
const { resolveCommits } = await import(new URL('forecast/git.js', root));
const out = { git: sh(process.cwd(), ['--version']), node: process.version, cpus: (await import('node:os')).cpus().length, forecast: [], hook: [], clash: null, stale: null };

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)];
const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };

function fleet(n, seed = 7) {
  const r = rng(seed);
  const base = baseFiles(30);
  const dir = initRepo(base);
  for (let a = 1; a <= n; a++) {
    sh(dir, ['checkout', '-q', '-b', `agent${a}`, 'main']);
    for (let t = 0; t < 2; t++) {
      const m = Math.floor(r() * 30), p = `src/m${String(m).padStart(2, '0')}.js`;
      const lines = base[p].split('\n'); lines[3 + Math.floor(r() * 3) * 7] = `  const a = x + ${a}; // agent ${a}`;
      writeFileSync(join(dir, p), lines.join('\n'));
    }
    sh(dir, ['commit', '-qam', `agent${a}`]);
    sh(dir, ['checkout', '-q', 'main']);
  }
  return dir;
}

for (const n of [10, 20, 40]) {
  const dir = fleet(n);
  const names = Array.from({ length: n }, (_, i) => `agent${i + 1}`);
  const pairs = (n * (n - 1)) / 2;
  textualCollisions(dir, names); // warm file cache
  const serial = [], batch = [], deep = [];
  for (let k = 0; k < 3; k++) {
    serial.push(time(() => textualCollisions(dir, names, undefined, { batch: false }))[0]);
    batch.push(time(() => textualCollisions(dir, names))[0]);
    const refs = names.map((nm) => ({ label: nm, oid: sh(dir, ['rev-parse', nm]) }));
    deep.push(time(() => deepForecast(dir, refs, { overlap: true, semantic: true }))[0]);
  }
  out.forecast.push({ branches: n, pairs, serial_ms: Math.round(median(serial)), batched_ms: Math.round(median(batch)), speedup: +(median(serial) / median(batch)).toFixed(1), deep_ms: Math.round(median(deep)) });
  cleanup(dir);
}

// repository with many stale branches (merged-but-not-deleted) plus 20 diverged agent branches,
// and what a forecast leaves behind in the object store
{
  const STALE = 300, LIVE = 20;
  const dir = fleet(LIVE);
  for (let i = 0; i < STALE; i++) sh(dir, ['branch', `stale${i}`, 'main']);
  const names = [...Array.from({ length: LIVE }, (_, i) => `agent${i + 1}`), ...Array.from({ length: STALE }, (_, i) => `stale${i}`)];
  const count = () => Number(/^count: (\d+)/m.exec(sh(dir, ['count-objects', '-v']))[1]);
  const [allMs] = time(() => textualCollisions(dir, names, undefined, { related: () => false }));
  const [skipMs] = time(() => textualCollisions(dir, names));
  const c0 = count();
  textualCollisions(dir, names);
  const quarantined = count() - c0;
  const oids = resolveCommits(dir, names);
  const c1 = count();
  mergeTreeBatch(dir, (() => { const l = []; for (let i = 0; i < LIVE; i++) for (let j = i + 1; j < LIVE; j++) l.push([oids.get(names[i]), oids.get(names[j])]); return l; })());
  const unquarantined = count() - c1;
  out.stale = { branches: names.length, pairs: (names.length * (names.length - 1)) / 2, all_pairs_ms: Math.round(allMs), skip_related_ms: Math.round(skipMs), objects_written_now: quarantined, objects_written_before: unquarantined };
  cleanup(dir);
}

// hook latency
{
  const dir = fleet(2);
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = tmp('cf-bench-store-');
  const env = { ...process.env, CEASEFIRE_DIR: store, CEASEFIRE_SYNC: '0', CEASEFIRE_AGENT: 'bench-agent' };
  const ev = (f) => JSON.stringify({ session_id: 'bench-session-1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, f) } });
  const run = (args, f) => time(() => spawnSync('node', [CLI, 'hook', 'claude', ...args], { cwd: dir, env, input: ev(f), encoding: 'utf8' }))[0];
  const bare = []; for (let i = 0; i < RUNS; i++) bare.push(spawnSync('node', ['-e', '0'], { cwd: dir }) && time(() => spawnSync('node', ['-e', '0']))[0]);
  const plain = [], lease = [];
  for (let i = 0; i < RUNS; i++) plain.push(run([], 'src/m01.js'));
  for (let i = 0; i < RUNS; i++) lease.push(run(['--claim'], `src/m${String(i % 20).padStart(2, '0')}.js`));
  const s = new IntentStore(join(store, 'intents.db'));
  for (let i = 0; i < 200; i++) s.publish(`task ${i}`, [`src/area${i}/`, `lib/**/mod${i}.ts`], { agent: `other${i % 20}`, branch: 'b' });
  s.close();
  const big = []; for (let i = 0; i < RUNS; i++) big.push(run(['--claim'], 'src/m02.js'));
  out.hook = [
    { case: 'node start-up alone (floor)', p50_ms: Math.round(median(bare)), p95_ms: Math.round(p95(bare)) },
    { case: 'hook, check only', p50_ms: Math.round(median(plain)), p95_ms: Math.round(p95(plain)) },
    { case: 'hook --claim (check + auto-lease)', p50_ms: Math.round(median(lease)), p95_ms: Math.round(p95(lease)) },
    { case: 'hook --claim, 200 intents in ledger', p50_ms: Math.round(median(big)), p95_ms: Math.round(p95(big)) },
  ];
  // Clash comparison on a 10-worktree fleet with uncommitted edits
  const clash = process.env.CLASH_BIN || 'clash';
  if (spawnSync(clash, ['--version'], { encoding: 'utf8' }).status === 0) {
    const wd = fleet(0);
    const wts = [];
    for (let w = 1; w <= 10; w++) {
      const p = join(tmp('cf-bench-wt-'), 'wt');
      sh(wd, ['worktree', 'add', '-q', '-b', `w${w}`, p, 'main']);
      writeFileSync(join(p, 'src/m00.js'), baseFiles(30)['src/m00.js'].replace('x + 0', `x + ${w}`));
      writeFileSync(join(p, `src/m${String(w).padStart(2, '0')}.js`), `// edit ${w}\n` + baseFiles(30)[`src/m${String(w).padStart(2, '0')}.js`]);
      wts.push(p);
    }
    const cenv = { ...process.env, CEASEFIRE_SYNC: '0', CEASEFIRE_DIR: tmp('cf-bench-store-') };
    const t = (cmd, args, cwd) => { const a = []; for (let i = 0; i < 7; i++) a.push(time(() => spawnSync(cmd, args, { cwd, env: cenv, encoding: 'utf8' }))[0]); return Math.round(median(a)); };
    out.clash = {
      worktrees: 10,
      clash_version: spawnSync(clash, ['--version'], { encoding: 'utf8' }).stdout.trim(),
      clash_status_json_ms: t(clash, ['status', '--json'], wts[0]),
      ceasefire_worktrees_ms: t('node', [CLI, 'conflicts', '--worktrees', '--json'], wts[0]),
      clash_check_ms: t(clash, ['check', 'src/m00.js'], wts[0]),
      ceasefire_hook_ms: Math.round(median(Array.from({ length: 7 }, () => time(() => spawnSync('node', [CLI, 'hook', 'claude'], { cwd: wts[0], env: cenv, input: JSON.stringify({ session_id: 'bench-session-1', cwd: wts[0], tool_name: 'Edit', tool_input: { file_path: join(wts[0], 'src/m00.js') } }), encoding: 'utf8' }))[0]))),
    };
  }
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`git ${out.git.replace('git version ', '')}, ${out.node}, ${out.cpus} cpu(s)\n`);
  console.log('all-pairs forecast (median of 3)');
  console.log('branches  pairs   per-pair-git   batched   speedup   --deep');
  for (const f of out.forecast) console.log(String(f.branches).padStart(8) + String(f.pairs).padStart(7) + (f.serial_ms + ' ms').padStart(14) + (f.batched_ms + ' ms').padStart(10) + (f.speedup + 'x').padStart(9) + (f.deep_ms + ' ms').padStart(9));
  if (out.stale) console.log(`\nstale branches: ${out.stale.branches} branches (${out.stale.pairs} pairs), 20 of them diverged\n  every pair ${out.stale.all_pairs_ms} ms | fast-forward pairs skipped ${out.stale.skip_related_ms} ms\n  loose objects left in the repo by one forecast: ${out.stale.objects_written_now} now vs ${out.stale.objects_written_before} before (20 branches, merges written to the repo)`);
  console.log(`\neditor hook, whole process (${RUNS} runs)`);
  for (const h of out.hook) console.log('  ' + h.case.padEnd(40) + `p50 ${h.p50_ms} ms   p95 ${h.p95_ms} ms`);
  if (out.clash) console.log(`\nvs Clash ${out.clash.clash_version} on ${out.clash.worktrees} worktrees with uncommitted edits (median of 7):\n  clash status --json ${out.clash.clash_status_json_ms} ms | ceasefire conflicts --worktrees ${out.clash.ceasefire_worktrees_ms} ms | clash check ${out.clash.clash_check_ms} ms | ceasefire hook ${out.clash.ceasefire_hook_ms} ms`);
  else console.log('\n(Clash not found: set CLASH_BIN to include it)');
}
