// hooks/harness-doctor.mjs — integrity checks for the a2 harness state (Wave B).
// Pure-ish (fs reads only). `wendkeep doctor` reports errors (exit 1) + warnings.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeChange, parseTasks } from './change-core.mjs';
import { buildEffectiveRequirementPackage, checkSpecsState, evaluateVerdict, tasksHashOf, validateSpecImpact } from './spec-core.mjs';
import { getLocale } from './locale.mjs';

export function checkHarness(vaultBase, projectRoot) {
  const loc = getLocale(vaultBase);
  const CHANGES_DIR = loc.folders.changes;
  const errors = [];
  const warnings = [];

  // 1. wendkeep.sensors.json well-formed.
  const sensorsPath = join(projectRoot, 'wendkeep.sensors.json');
  if (existsSync(sensorsPath)) {
    try {
      const data = JSON.parse(readFileSync(sensorsPath, 'utf8'));
      if (!Array.isArray(data.sensors)) errors.push('wendkeep.sensors.json: "sensors" não é lista');
      else for (const s of data.sensors) if (!s.id || !s.command) errors.push(`sensor sem id/command: ${JSON.stringify(s.id || '?')}`);
    } catch { errors.push('wendkeep.sensors.json: JSON inválido'); }
  }

  const specState = checkSpecsState(vaultBase);
  if (specState.missing) warnings.push('SPECS_STATE ausente — rode `wendkeep spec migrate`; 07-Specs deve ser gerado/read-only');
  else if (!specState.ok) errors.push(`07-Specs alterado fora do WendKeep: ${specState.changed.join(', ')} — mova a alteração para 08-Mudanças/<change>/specs`);

  // 2/3. Changes: malformed dirs; the active change's deltas add to knownReqs.
  const active = activeChange(vaultBase);
  let names = [];
  try { names = readdirSync(join(vaultBase, CHANGES_DIR)).filter((n) => n !== '_arquivo'); } catch { /* none */ }
  for (const name of names) {
    const dir = join(vaultBase, CHANGES_DIR, name);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; } // a file, not a change dir
    if (!entries.includes('proposta.md')) { errors.push(`change sem proposta.md: ${name}`); continue; }
    const impact = validateSpecImpact(dir);
    errors.push(...impact.errors.map((e) => `${name}: ${e}`));
    warnings.push(...impact.warnings.map((w) => `${name}: ${w}`));
    let tasks = [];
    let tarefasMd = '';
    try { tarefasMd = readFileSync(join(dir, 'tarefas.md'), 'utf8'); tasks = parseTasks(tarefasMd); } catch { /* sem tarefas */ }
    const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
    const effective = buildEffectiveRequirementPackage(vaultBase, dir, reqIds);
    errors.push(...effective.errors.map((e) => `${name}: spec efetiva inválida: ${e}`));
    if (effective.missing.length) errors.push(`req órfão em ${name}: ${effective.missing.map((id) => `[req:${id}]`).join(', ')} não existe na spec efetiva`);
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
    if (verdict && reqIds.length) {
      const v = evaluateVerdict(verdict, reqIds, { tasksHash: tasksHashOf(tarefasMd), effectiveSpecHash: effective.hash });
      if (!v.ok) warnings.push(`verdict stale/incompleto em ${name}${v.missing.length ? `: falta cobrir ${v.missing.join(', ')}` : ''}`);
    }
  }

  // 4/5. Active-change pointer resolves; [req:] orphans; stale verdict.
  if (active) {
    const dir = join(vaultBase, CHANGES_DIR, active);
    if (!existsSync(join(dir, 'proposta.md'))) {
      errors.push(`ponteiro CURRENT_CHANGE aponta pra change inexistente: ${active}`);
    }
  }

  return { errors, warnings };
}
