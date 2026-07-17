// hooks/sensors-core.mjs — native sensor runner + evidence gate (Pilar C).
// Pure-ish: `spawn` is injectable so runs are testable without a shell. Config lives
// at the PROJECT ROOT (wendkeep.sensors.json); evidence lives per-change in the vault.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function loadSensors(projectRoot, file = 'wendkeep.sensors.json') {
  return loadSensorsDetailed(projectRoot, file).sensors;
}

// Missing config and broken config are different failures: absent file usually means
// wrong cwd (subdirectory), broken JSON means the config itself needs fixing. Collapsing
// both into [] made every sensor report "sensor não definido" — a misleading diagnosis.
export function loadSensorsDetailed(projectRoot, file = 'wendkeep.sensors.json') {
  const path = join(projectRoot, file);
  if (!existsSync(path)) return { sensors: [], missing: true, error: null, path };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return { sensors: Array.isArray(data.sensors) ? data.sensors : [], missing: false, error: null, path };
  } catch (e) {
    return { sensors: [], missing: false, error: e.message, path };
  }
}

// Climb the directory tree looking for a project marker (wendkeep.sensors.json or
// .wendkeep.json), like git does with .git — shells in agent harnesses keep their cwd
// across commands, so verify is often run from a subdirectory.
export function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'wendkeep.sensors.json')) || existsSync(join(dir, '.wendkeep.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requiredSensors(tasks) {
  return [...new Set((tasks || []).map((t) => t.sensor).filter(Boolean))];
}

export function runSensors(sensors, ids, { spawn = spawnSync, cwd, now } = {}) {
  const byId = Object.fromEntries((sensors || []).map((s) => [s.id, s]));
  const ts = now || new Date().toISOString();
  const evidence = [];
  for (const id of ids) {
    const s = byId[id];
    if (!s) { evidence.push({ id, status: 'red', ts, severity: 'critical', note: 'sensor não definido' }); continue; }
    const r = spawn(s.command, [], { cwd, shell: true, stdio: 'ignore' });
    const entry = { id, status: (r.status ?? 1) === 0 ? 'green' : 'red', ts, severity: s.severity || 'critical' };
    if (s.type === 'mutation' && s.report) {
      // Delegated mutation (Wave B): read the tool's mutation-testing-elements report and
      // attach surviving mutants so verify can turn them into fix tasks.
      try { entry.survivors = parseMutationReport(JSON.parse(readFileSync(join(cwd || '.', s.report), 'utf8'))); }
      catch { /* report ausente/ilegível — segue só com o exit code */ }
    }
    evidence.push(entry);
  }
  return evidence;
}

// Parse a mutation-testing-elements report (Stryker et al.): return surviving mutants
// (Survived | NoCoverage) as {file, line, mutator}.
export function parseMutationReport(json) {
  const out = [];
  const files = json && json.files ? json.files : {};
  for (const [file, data] of Object.entries(files)) {
    for (const m of (data && data.mutants) || []) {
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        out.push({ file, line: m.location && m.location.start ? m.location.start.line : null, mutator: m.mutatorName || 'unknown' });
      }
    }
  }
  return out;
}

// A required sensor blocks the gate when it is missing (never verified) or red at a
// non-warning severity. Warnings are advisory: a red warning does not block archive.
// Severity comes from the evidence entry (written by runSensors); absent -> critical.
export function evaluateGate(evidence, requiredIds) {
  const byId = Object.fromEntries((evidence || []).map((e) => [e.id, e]));
  const failing = (requiredIds || []).filter((id) => {
    const e = byId[id];
    if (!e) return true; // never verified
    if (e.status === 'green') return false;
    return (e.severity || 'critical') !== 'warning';
  });
  return { ok: failing.length === 0, failing };
}
