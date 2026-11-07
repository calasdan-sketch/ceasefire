// Forecast accuracy vs ground truth on generated multi-agent histories.
//   node bench/accuracy.mjs [--histories 12] [--agents 6] [--mods 10] [--seed 1] [--json]
// Ground truth for every agent pair, produced independently of ceasefire:
//   TEXTUAL  : a real `git merge` of the two branches stops with conflicts
//   BREAKS   : the merge is clean but `node check.mjs` (real ES-module linking) fails
//   OK       : clean merge, check passes
// Detectors are the library functions exactly as `ceasefire conflicts` calls them.
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sh, rng, baseFiles, initRepo, cleanup, tmp } from './lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HIST = arg('histories', 12), AGENTS = arg('agents', 6), MODS = arg('mods', 10), SEED = arg('seed', 1);
const JSON_OUT = process.argv.includes('--json');
const root = new URL('../dist/', import.meta.url);
const { textualCollisions } = await import(new URL('forecast/forecast.js', root));
const { deepForecast } = await import(new URL('forecast/deep.js', root));
const { annotateRegenerable } = await import(new URL('cli/commands.js', root));

const pad = (n) => String(n).padStart(2, '0');
const mpath = (m) => `src/m${pad(m)}.js`;
const FN = (m, k) => `f_${m}_${k}`;

function edit(files, p, fn) { files[p] = fn(files[p]); }

/** Apply one task to the in-memory file map of an agent's branch. */
function applyTask(files, task, R, uid) {
  // An earlier task of the same agent may have renamed the target: then this task is a no-op.
  if ((task.kind === 'add-caller' || task.kind === 'edit-body' || task.kind === 'rename' || task.kind === 'new-module') && !files[mpath(task.m)].includes(`export function ${FN(task.m, task.k)}(`)) return;
  if (task.kind === 'edit-body') {
    edit(files, mpath(task.m), (t) => {
      const lines = t.split('\n');
      const at = lines.findIndex((l) => l.startsWith(`export function ${FN(task.m, task.k)}(`));
      lines[at + 2] = `  const b = a * ${3 + (uid % 7)}; // agent ${uid}`;
      return lines.join('\n');
    });
  } else if (task.kind === 'rename') {
    const from = FN(task.m, task.k), to = `g_${task.m}_${task.k}_${uid}`;
    for (const p of Object.keys(files)) if (p.startsWith('src/')) files[p] = files[p].replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  } else if (task.kind === 'add-caller') {
    edit(files, mpath(task.y), (t) => {
      const already = t.includes(`import { ${FN(task.m, task.k)} }`) || task.y === task.m;
      const alias = uid % 5 === 0 || already;
      const imp = alias ? `import { ${FN(task.m, task.k)} as callee${uid} } from './m${pad(task.m)}.js';\n` : `import { ${FN(task.m, task.k)} } from './m${pad(task.m)}.js';\n`;
      const use = alias ? `callee${uid}` : FN(task.m, task.k);
      return imp + t + `\nexport function extra_${task.y}_${uid}(x) {\n  return ${use}(x) * 2;\n}\n`;
    });
  } else if (task.kind === 'lockfile') {
    edit(files, 'package-lock.json', (t) => t.replace(`"version": "1.0.${task.k}"`, `"version": "2.${uid}.${task.k}"`));
  } else if (task.kind === 'new-module') {
    files[`src/new_${uid}.js`] = `import { ${FN(task.m, task.k)} } from './m${pad(task.m)}.js';\nexport function n_${uid}(x) {\n  return ${FN(task.m, task.k)}(x);\n}\n`;
  }
}

function pickTask(r) {
  const x = r();
  const m = Math.floor(r() * Math.min(MODS, 3));          // hot subset of modules -> real contention
  const k = Math.floor(r() * 4);
  if (x < 0.30) return { kind: 'edit-body', m, k };
  if (x < 0.50) return { kind: 'rename', m, k: k % 2 === 0 ? 0 : 1 };    // exports that other modules import
  if (x < 0.78) { let y = Math.floor(r() * Math.min(MODS, 3)); if (y === m) y = (y + 1) % MODS; return { kind: 'add-caller', m, k: k % 2 === 0 ? 0 : 1, y }; }
  if (x < 0.90) return { kind: 'lockfile', k: Math.floor(r() * 6) };
  return { kind: 'new-module', m, k: k % 2 === 0 ? 0 : 1 };
}

const counts = { pairs: 0, TEXTUAL: 0, BREAKS: 0, OK: 0 };
const det = {
  'merge-tree only (ceasefire 0.2)': { flag: 0, tp: 0, fp: 0, fn: 0, semTp: 0, semFn: 0, noisy: 0 },
  '+ overlap (--overlap)': { flag: 0, tp: 0, fp: 0, fn: 0, semTp: 0, semFn: 0, noisy: 0 },
  '+ semantic (--semantic)': { flag: 0, tp: 0, fp: 0, fn: 0, semTp: 0, semFn: 0, noisy: 0 },
  '--deep (overlap+semantic)': { flag: 0, tp: 0, fp: 0, fn: 0, semTp: 0, semFn: 0, noisy: 0 },
  '--deep --neighbors': { flag: 0, tp: 0, fp: 0, fn: 0, semTp: 0, semFn: 0, noisy: 0 },
};
let regenOnly = 0, textualTotal = 0, batchMismatch = 0;

for (let h = 0; h < HIST; h++) {
  const r = rng(SEED * 1000 + h);
  const base = baseFiles(MODS);
  const dir = initRepo(base);
  const names = [];
  for (let a = 0; a < AGENTS; a++) {
    const files = { ...base };
    const n = 1 + (r() < 0.4 ? 1 : 0);
    for (let t = 0; t < n; t++) applyTask(files, pickTask(r), r, a + 1);
    sh(dir, ['checkout', '-q', '-b', `agent${a + 1}`, 'main']);
    for (const [p, t] of Object.entries(files)) if (t !== base[p]) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); }
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-qm', `agent${a + 1}`, '--allow-empty']);
    names.push(`agent${a + 1}`);
    sh(dir, ['checkout', '-q', 'main']);
  }
  // single-agent sanity: every branch must pass the checker on its own, or the generator is wrong
  const scratch = tmp('cf-bench-wt-');
  sh(dir, ['worktree', 'add', '-q', '--detach', scratch, 'main']);
  const check = () => spawnSync('node', ['check.mjs'], { cwd: scratch, encoding: 'utf8' }).status === 0;
  for (const n of names) { sh(scratch, ['checkout', '-q', '-f', n]); if (!check()) { console.error(spawnSync('node', ['check.mjs'], { cwd: scratch, encoding: 'utf8' }).stderr.slice(0, 500)); throw new Error(`generator bug: ${n} alone fails the check`); } }

  const truth = new Map();
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    sh(scratch, ['checkout', '-q', '-f', names[i]]);
    let label;
    try { sh(scratch, ['merge', '--no-commit', '--no-ff', '-q', names[j]]); label = check() ? 'OK' : 'BREAKS'; }
    catch { label = 'TEXTUAL'; }
    try { sh(scratch, ['merge', '--abort']); } catch { /* clean merge left nothing to abort */ }
    sh(scratch, ['reset', '-q', '--hard']);
    truth.set(`${names[i]}\0${names[j]}`, label);
    counts.pairs++; counts[label]++;
  }
  sh(dir, ['worktree', 'remove', '--force', scratch]);

  const textual = annotateRegenerable(textualCollisions(dir, names));
  const serial = textualCollisions(dir, names, undefined, { batch: false });
  const key = (cs) => JSON.stringify(cs.map((c) => [c.prA, c.prB, c.files]).sort());
  if (key(textual) !== key(serial)) batchMismatch++;
  const refs = names.map((n) => ({ label: n, oid: sh(dir, ['rev-parse', n]) }));
  const tmap = new Map(textual.map((c) => [`${c.prA}\0${c.prB}`, c.files]));
  textualTotal += textual.length;
  regenOnly += textual.filter((c) => c.regenerable).length;
  const run = (o) => deepForecast(dir, refs, { ...o, textual: tmap }).collisions;
  const overlap = run({ overlap: true }), semantic = run({ semantic: true }), deep = run({ overlap: true, semantic: true }), neigh = run({ overlap: true, semantic: true, neighbors: true });

  const flaggedBy = (cs) => { const s = new Set(); for (const c of cs) { s.add(`${c.prA}\0${c.prB}`); s.add(`${c.prB}\0${c.prA}`); } return s; };
  const T = flaggedBy(textual);
  const sets = {
    'merge-tree only (ceasefire 0.2)': T,
    '+ overlap (--overlap)': flaggedBy([...textual, ...overlap]),
    '+ semantic (--semantic)': flaggedBy([...textual, ...semantic]),
    '--deep (overlap+semantic)': flaggedBy([...textual, ...deep]),
    '--deep --neighbors': flaggedBy([...textual, ...neigh]),
  };
  for (const [k, label] of truth) {
    const [a, b] = k.split('\0');
    for (const [name, flagged] of Object.entries(sets)) {
      const d = det[name];
      const f = flagged.has(k) || flagged.has(`${b}\0${a}`);
      const positive = label !== 'OK';
      if (f) d.flag++;
      if (f && positive) d.tp++; else if (f && !positive) d.fp++; else if (!f && positive) d.fn++;
      if (label === 'BREAKS') { if (f) d.semTp++; else d.semFn++; }
    }
  }
  cleanup(dir); cleanup(scratch);
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const rows = Object.entries(det).map(([name, d]) => ({
  detector: name, flagged: d.flag,
  precision: d.flag ? d.tp / d.flag : 1,
  recall: d.tp + d.fn ? d.tp / (d.tp + d.fn) : 1,
  breaksRecall: d.semTp + d.semFn ? d.semTp / (d.semTp + d.semFn) : 1,
  falseAlarms: d.fp,
}));
const out = { histories: HIST, agents: AGENTS, modules: MODS, seed: SEED, pairs: counts.pairs, truth: { TEXTUAL: counts.TEXTUAL, BREAKS: counts.BREAKS, OK: counts.OK }, textualCollisions: textualTotal, regenerableTextual: regenOnly, batchVsSerialMismatches: batchMismatch, detectors: rows };
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`accuracy: ${HIST} histories x ${AGENTS} agents, ${MODS} modules, seed ${SEED} -> ${counts.pairs} agent pairs`);
  console.log(`ground truth (real git merge + real node link check): TEXTUAL ${counts.TEXTUAL}, BREAKS-despite-clean-merge ${counts.BREAKS}, OK ${counts.OK}`);
  console.log(`batch merge-tree == per-pair merge-tree in ${HIST - batchMismatch}/${HIST} histories; ${regenOnly}/${textualTotal} textual collisions are lockfile-only (regenerable)\n`);
  console.log('detector'.padEnd(34) + 'flagged  precision  recall  recall(breaks)  false-alarms');
  for (const r of rows) console.log(r.detector.padEnd(34) + String(r.flagged).padStart(7) + pct(r.precision).padStart(11) + pct(r.recall).padStart(8) + pct(r.breaksRecall).padStart(15) + String(r.falseAlarms).padStart(14));
}
