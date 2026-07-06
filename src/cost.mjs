// `wendkeep cost` — aggregate AI-coding spend across every session note in the vault.
// Each session note carries cost in its frontmatter (main + subagents since 0.10.0); this
// rolls the whole vault up: total, by day, by model. Pure aggregation + a thin CLI.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getLocale } from '../hooks/locale.mjs';

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;

function fmValue(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

// Parse the cost-relevant frontmatter of one note; null if it is not a session note.
export function parseSessionCost(content) {
  if (!/^type:\s*session\s*$/m.test(content)) return null;
  return {
    date: (fmValue(content, 'date') || '').slice(0, 10),
    model: fmValue(content, 'custo_modelo_label') || fmValue(content, 'modelo') || '?',
    mainCost: Number(fmValue(content, 'custo_modelo_usd')) || 0,
    subCost: Number(fmValue(content, 'subagents_custo_usd')) || 0,
    tokens: Number(fmValue(content, 'tokens_total')) || 0,
    subTokens: Number(fmValue(content, 'subagents_tokens_total')) || 0,
  };
}

export function aggregateCosts(entries) {
  const byDay = {};
  const byModel = {};
  let main = 0;
  let sub = 0;
  let tokens = 0;
  let subTokens = 0;
  for (const e of entries) {
    main += e.mainCost; sub += e.subCost; tokens += e.tokens; subTokens += e.subTokens;
    const d = e.date || '?';
    (byDay[d] = byDay[d] || { cost: 0, count: 0 }).cost += e.mainCost + e.subCost;
    byDay[d].count += 1;
    (byModel[e.model] = byModel[e.model] || { cost: 0, count: 0 }).cost += e.mainCost + e.subCost;
    byModel[e.model].count += 1;
  }
  return {
    count: entries.length,
    main: round4(main), sub: round4(sub), total: round4(main + sub),
    tokens, subTokens,
    byDay: Object.entries(byDay).sort().map(([date, v]) => ({ date, cost: round4(v.cost), count: v.count })),
    byModel: Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost).map(([model, v]) => ({ model, cost: round4(v.cost), count: v.count })),
  };
}

function walkNotes(dir) {
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkNotes(p));
    else if (n.endsWith('.md')) out.push(p);
  }
  return out;
}

export function collectVaultCost(vaultBase, { since } = {}) {
  const sessionsDir = join(vaultBase, getLocale(vaultBase).folders.sessions);
  const entries = [];
  for (const f of walkNotes(sessionsDir)) {
    let e;
    try { e = parseSessionCost(readFileSync(f, 'utf8')); } catch { continue; }
    if (!e) continue;
    if (since && e.date && e.date < since) continue;
    entries.push(e);
  }
  return aggregateCosts(entries);
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runCost(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep cost: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep cost: vault not found: ${vaultBase}\n`); process.exit(2); }
  const agg = collectVaultCost(vaultBase, { since: opt(argv, '--since') });

  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`); process.exit(0); }

  process.stdout.write(`Custo total (vault): ${usd(agg.total)} — ${agg.count} sessão(ões)\n`);
  process.stdout.write(`  main: ${usd(agg.main)} · subagents: ${usd(agg.sub)}\n`);
  if (agg.byModel.length) {
    process.stdout.write('\nPor modelo:\n');
    for (const m of agg.byModel) process.stdout.write(`  ${m.model.padEnd(20)} ${usd(m.cost)}  (${m.count})\n`);
  }
  if (agg.byDay.length) {
    process.stdout.write('\nPor dia:\n');
    for (const d of agg.byDay) process.stdout.write(`  ${d.date}  ${usd(d.cost)}  (${d.count})\n`);
  }
  process.exit(0);
}
