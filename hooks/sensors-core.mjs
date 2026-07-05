// hooks/sensors-core.mjs — native sensor runner + evidence gate (Pilar C).
// Pure-ish: `spawn` is injectable so runs are testable without a shell. Config lives
// at the PROJECT ROOT (wendkeep.sensors.json); evidence lives per-change in the vault.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadSensors(projectRoot, file = 'wendkeep.sensors.json') {
  try {
    const data = JSON.parse(readFileSync(join(projectRoot, file), 'utf8'));
    return Array.isArray(data.sensors) ? data.sensors : [];
  } catch {
    return [];
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
    evidence.push({ id, status: (r.status ?? 1) === 0 ? 'green' : 'red', ts, severity: s.severity || 'critical' });
  }
  return evidence;
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
