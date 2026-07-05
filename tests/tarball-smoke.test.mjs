// Tarball smoke test (debt fix 3a): assert the published npm package actually
// ships every file the hooks need. Catches a future .npmignore / rename / files[]
// edit that would publish a package whose hooks fail at `import` after install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES } from '../src/taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// Files that `npm publish` would include, per `npm pack`.
// Command is a single string with shell:true (npm is a .cmd shim on Windows); this
// also avoids DEP0190, which only fires when an args array is combined with shell.
function publishedFiles() {
  const r = spawnSync('npm pack --dry-run --json', {
    cwd: pkgRoot,
    encoding: 'utf8',
    shell: true,
  });
  assert.equal(r.status, 0, `npm pack failed:\n${r.stderr}`);
  const raw = r.stdout.slice(r.stdout.indexOf('['), r.stdout.lastIndexOf(']') + 1);
  const meta = JSON.parse(raw);
  return new Set((meta[0]?.files || []).map((f) => f.path.replace(/\\/g, '/')));
}

// Relative ESM specifiers (static + dynamic) referenced by a source file.
function relativeImports(code) {
  const specifiers = [];
  const re = /(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) specifiers.push(m[1]);
  return specifiers;
}

test('every HOOK_FILES entry is in the published tarball', () => {
  const published = publishedFiles();
  for (const f of HOOK_FILES) {
    assert.ok(published.has(`hooks/${f}`), `missing from package: hooks/${f}`);
  }
});

test('every relative import in hooks/ resolves to a published file', () => {
  const published = publishedFiles();
  const hooksDir = join(pkgRoot, 'hooks');
  const mjs = readdirSync(hooksDir).filter((f) => f.endsWith('.mjs'));

  for (const file of mjs) {
    const code = readFileSync(join(hooksDir, file), 'utf8');
    for (const spec of relativeImports(code)) {
      // resolve spec relative to hooks/<file>, expressed as a posix package path
      const target = posix.normalize(posix.join('hooks', posix.dirname(file), spec));
      assert.ok(
        published.has(target),
        `${file} imports "${spec}" -> ${target}, not in published package`,
      );
    }
  }
});

test('every published hook passes node --check (no broken syntax shipped)', () => {
  const hooksDir = join(pkgRoot, 'hooks');
  const mjs = readdirSync(hooksDir).filter((f) => f.endsWith('.mjs'));
  for (const file of mjs) {
    const r = spawnSync(process.execPath, ['--check', join(hooksDir, file)], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `node --check failed for ${file}:\n${r.stderr}`);
  }
});
