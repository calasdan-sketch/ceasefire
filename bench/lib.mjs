// Shared helpers for the committed benchmarks. Plain ESM, imports the built dist/.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sh(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost', ...opts.env },
  }).trim();
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const tmp = (p) => mkdtempSync(join(process.env.CEASEFIRE_BENCH_TMP || tmpdir(), p));
export const cleanup = (d) => rmSync(d, { recursive: true, force: true });

const FNS = 4;

/** A small ES-module code base: `mods` modules x 4 functions, each calling a function of another module. */
export function baseFiles(mods) {
  const files = {};
  const name = (m, k) => `f_${m}_${k}`;
  for (let m = 0; m < mods; m++) {
    const dep = (m + 1) % mods;
    const dep2 = (m + 2) % mods;
    let t = `import { ${name(dep, 0)} } from './m${String(dep).padStart(2, '0')}.js';\nimport { ${name(dep2, 1)} } from './m${String(dep2).padStart(2, '0')}.js';\n\n`;
    for (let k = 0; k < FNS; k++) {
      const callee = k % 2 === 0 ? name(dep, 0) : name(dep2, 1);
      t += `export function ${name(m, k)}(x) {\n  const a = x + ${m * 10 + k};\n  const b = a * 2;\n  const c = b - ${k};\n  return ${callee}(c) + 1;\n}\n\n`;
    }
    t += `export const run = () => ${name(m, 0)}(1);\n`;
    files[`src/m${String(m).padStart(2, '0')}.js`] = t;
  }
  // cycle-free enough: functions only call functions of other modules; run() is never invoked recursively by check.
  files['package.json'] = '{ "name": "bench", "type": "module", "version": "1.0.0" }\n';
  let lock = '{\n  "lockfileVersion": 3,\n  "packages": {\n';
  for (let i = 0; i < 40; i++) lock += `    "node_modules/dep${i}": {\n      "version": "1.0.${i}",\n      "resolved": "https://registry.example/dep${i}-1.0.${i}.tgz"\n    },\n`;
  lock += '    "": {}\n  }\n}\n';
  files['package-lock.json'] = lock;
  files['check.mjs'] =
    `import { readdirSync } from 'node:fs';\nconst dir = new URL('./src/', import.meta.url);\nfor (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {\n  const m = await import(new URL(f, dir));\n  if (typeof m.run === 'function') { /* linking is the real test: a missing export throws before this line */ }\n}\n`;
  return files;
}

export function writeFiles(dir, files) {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
}

export function initRepo(files) {
  const dir = tmp('cf-bench-');
  sh(dir, ['init', '-q', '-b', 'main']);
  writeFiles(dir, files);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'base']);
  return dir;
}

export function readWork(dir, p) {
  return readFileSync(join(dir, p), 'utf8');
}
