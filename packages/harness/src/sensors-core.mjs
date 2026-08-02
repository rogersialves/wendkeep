// hooks/sensors-core.mjs — native sensor runner + evidence gate (Pilar C).
// Pure-ish: `spawn` is injectable so runs are testable without a shell. Config lives
// at the PROJECT ROOT (wendkeep.sensors.json); evidence lives per-change in the vault.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const SENSOR_VAULT_ENV = 'WENDKEEP_SENSOR_VAULT';
const SENSOR_OUTPUT_MAX_BUFFER = 8 * 1024 * 1024;
const SENSOR_DIAGNOSTIC_MAX_LENGTH = 2000;

function sanitizeSensorDiagnostic(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(whsec_[A-Za-z0-9_/-]{8,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://[REDACTED_SECRET]@')
    .replace(/\r/g, '')
    .trim();
}

function sensorFailureNote(result = {}) {
  const status = result.status ?? 'null';
  const header = [
    `exit=${status}`,
    ...(result.signal ? [`signal=${result.signal}`] : []),
  ].join(' ');
  const detail = sanitizeSensorDiagnostic([
    result.error?.message,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'));
  if (!detail) return header;
  const room = SENSOR_DIAGNOSTIC_MAX_LENGTH - header.length - 1;
  const bounded = detail.length > room ? `…${detail.slice(-(room - 1))}` : detail;
  return `${header}\n${bounded}`;
}

export function sensorProcessEnv(vaultBase, inherited = process.env) {
  return {
    ...inherited,
    OBSIDIAN_VAULT_PATH: vaultBase,
    [SENSOR_VAULT_ENV]: vaultBase,
  };
}

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
  return [...new Set((tasks || []).flatMap((task) => (
    Array.isArray(task.sensors) && task.sensors.length ? task.sensors : [task.sensor]
  )).filter(Boolean))];
}

export function runSensors(sensors, ids, { spawn = spawnSync, cwd, env, now } = {}) {
  const byId = Object.fromEntries((sensors || []).map((s) => [s.id, s]));
  const ts = now || new Date().toISOString();
  const evidence = [];
  for (const id of ids) {
    const s = byId[id];
    if (!s) { evidence.push({ id, status: 'red', ts, severity: 'critical', note: 'sensor não definido' }); continue; }
    const r = spawn(s.command, [], {
      cwd,
      shell: true,
      encoding: 'utf8',
      maxBuffer: SENSOR_OUTPUT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });
    const entry = { id, status: (r.status ?? 1) === 0 ? 'green' : 'red', ts, severity: s.severity || 'critical' };
    if (entry.status === 'red') entry.note = sensorFailureNote(r);
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
