// hooks/harness-doctor.mjs — integrity checks for the a2 harness state (Wave B).
// Pure-ish (fs reads only). `wendkeep doctor` reports errors (exit 1) + warnings.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeChange, parseTasks } from './change-core.mjs';
import { parseRequirements, parseSpecsList, parseDelta, evaluateVerdict, validateSpecImpact } from './spec-core.mjs';
import { getLocale } from './locale.mjs';

export function checkHarness(vaultBase, projectRoot) {
  const loc = getLocale(vaultBase);
  const CHANGES_DIR = loc.folders.changes;
  const SPECS_DIR = loc.folders.specs;
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

  // Known requirement ids across the living specs (+ spec-without-source warning).
  const knownReqs = new Set();
  try {
    for (const f of readdirSync(join(vaultBase, SPECS_DIR))) {
      if (!f.endsWith('.md') || f === 'README.md') continue;
      const md = readFileSync(join(vaultBase, SPECS_DIR, f), 'utf8');
      for (const r of parseRequirements(md)) if (r.id) knownReqs.add(r.id);
      if (!/^>\s+Atualizado por/m.test(md)) warnings.push(`spec sem origem: ${SPECS_DIR}/${f}`);
    }
  } catch { /* sem 07-Specs */ }

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
    if (name === active) {
      try {
        for (const cap of parseSpecsList(readFileSync(join(dir, 'proposta.md'), 'utf8'))) {
          try {
            const d = parseDelta(readFileSync(join(dir, 'specs', cap, 'spec.md'), 'utf8'));
            for (const r of [...d.added, ...d.modified]) if (r.id) knownReqs.add(r.id);
          } catch { /* sem delta pra essa cap */ }
        }
      } catch { /* proposta ilegível */ }
    }
  }

  // 4/5. Active-change pointer resolves; [req:] orphans; stale verdict.
  if (active) {
    const dir = join(vaultBase, CHANGES_DIR, active);
    if (!existsSync(join(dir, 'proposta.md'))) {
      errors.push(`ponteiro CURRENT_CHANGE aponta pra change inexistente: ${active}`);
    } else {
      let tasks = [];
      try { tasks = parseTasks(readFileSync(join(dir, 'tarefas.md'), 'utf8')); } catch { /* sem tarefas */ }
      const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
      for (const rid of reqIds) if (!knownReqs.has(rid)) errors.push(`req órfão em ${active}: [req:${rid}] não existe em 07-Specs nem no delta`);
      let verdict = null;
      try { verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* sem verdict */ }
      if (verdict && reqIds.length) {
        const v = evaluateVerdict(verdict, reqIds);
        if (!v.ok) warnings.push(`verdict stale em ${active}: falta cobrir ${v.missing.join(', ')}`);
      }
    }
  }

  return { errors, warnings };
}
