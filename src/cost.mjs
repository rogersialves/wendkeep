// `wendkeep cost` — aggregate AI-coding spend across every session note in the vault.
// Each session note carries cost in its frontmatter (main + subagents since 0.10.0); this
// rolls the whole vault up: total, by day, by model. Pure aggregation + a thin CLI.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getLocale } from '../hooks/locale.mjs';
import { rebuildSessionCosts } from './rebuild-costs.mjs';

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function fmValue(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

// Parse the cost-relevant frontmatter of one note; null if it is not a session note.
export function parseSessionCost(content) {
  if (!/^type:\s*session\s*$/m.test(content)) return null;
  let ledger = [];
  try {
    const raw = fmValue(content, 'custo_por_modelo_json').replaceAll("''", "'");
    if (raw) ledger = JSON.parse(raw);
  } catch { /* legacy/malformed note: use safe fallback below */ }
  return {
    date: (fmValue(content, 'date') || '').slice(0, 10),
    model: fmValue(content, 'custo_modelo_label') || fmValue(content, 'modelo') || '?',
    mainCost: Number(fmValue(content, 'custo_modelo_usd')) || 0,
    subCost: Number(fmValue(content, 'subagents_custo_usd')) || 0,
    wasted: Number(fmValue(content, 'subagents_wasted_usd')) || 0,
    tokens: Number(fmValue(content, 'tokens_total')) || 0,
    subTokens: Number(fmValue(content, 'subagents_tokens_total')) || 0,
    prompts: Number(fmValue(content, 'prompts')) || 0,
    ledger,
  };
}

export function aggregateCosts(entries) {
  const byDay = {};
  const byModel = {};
  let main = 0;
  let sub = 0;
  let wasted = 0;
  let tokens = 0;
  let subTokens = 0;
  let prompts = 0;
  for (const e of entries) {
    main += e.mainCost; sub += e.subCost; wasted += e.wasted || 0; tokens += e.tokens; subTokens += e.subTokens; prompts += e.prompts || 0;
    const d = e.date || '?';
    (byDay[d] = byDay[d] || { cost: 0, count: 0 }).cost += e.mainCost + e.subCost;
    byDay[d].count += 1;
    const rows = e.ledger?.length ? e.ledger : [
      { model: e.model, cost: e.mainCost },
      ...(e.subCost ? [{ model: 'subagents (legado, modelo desconhecido)', cost: e.subCost }] : []),
    ];
    const seen = new Set();
    for (const row of rows) {
      const model = row.model || '?';
      (byModel[model] = byModel[model] || { cost: 0, count: 0 }).cost += Number(row.cost) || 0;
      if (!seen.has(model)) { byModel[model].count += 1; seen.add(model); }
    }
  }
  const total = main + sub;
  return {
    count: entries.length,
    main: round4(main), sub: round4(sub), total: round4(total), wasted: round4(wasted),
    avg: round4(entries.length ? total / entries.length : 0),
    tokens, subTokens, prompts,
    byDay: Object.entries(byDay).sort().map(([date, v]) => ({ date, cost: round4(v.cost), count: v.count })),
    byModel: Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost).map(([model, v]) => ({ model, cost: round4(v.cost), count: v.count })),
  };
}

// Shift a 'YYYY-MM-DD' string by `delta` days (UTC, pure).
function shiftDate(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ISO-ish week key 'YYYY-Www' for a 'YYYY-MM-DD' string (pure).
function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Group the per-day cost series (agg.byDay) into day|week|month buckets. Pure.
export function trendBuckets(byDay, bucket = 'month') {
  const keyOf = (date) => (bucket === 'day' ? date : bucket === 'week' ? isoWeek(date) : String(date).slice(0, 7));
  const map = {};
  for (const d of byDay || []) {
    if (!d.date || d.date === '?') continue;
    const k = keyOf(d.date);
    (map[k] = map[k] || { period: k, cost: 0, count: 0 }).cost += d.cost;
    map[k].count += d.count;
  }
  return Object.values(map).sort((a, b) => a.period.localeCompare(b.period)).map((b) => ({ ...b, cost: round4(b.cost) }));
}

// Run-rate projection from the last `windowDays` of activity. Pure; nowStr = 'YYYY-MM-DD'
// (defaults to the latest day seen). Honest: a flat run-rate, not a fitted forecast.
export function projectSpend(byDay, { nowStr, windowDays = 30, horizonDays = 30 } = {}) {
  const days = (byDay || []).filter((d) => d.date && d.date !== '?');
  if (!days.length) return { dailyRate: 0, projected: 0, windowDays, horizonDays, basisDays: 0, basisTotal: 0 };
  const now = nowStr || days[days.length - 1].date;
  const cutoff = shiftDate(now, -windowDays);
  const recent = days.filter((d) => d.date > cutoff);
  const basisTotal = recent.reduce((s, d) => s + d.cost, 0);
  const dailyRate = basisTotal / windowDays;
  return { dailyRate: round4(dailyRate), projected: round4(dailyRate * horizonDays), windowDays, horizonDays, basisDays: recent.length, basisTotal: round4(basisTotal) };
}

// A generated vault note: cost by month + projection + top models. Overwrites (it is generated).
export function renderTrendNote(agg, proj, dateStr) {
  const rows = trendBuckets(agg.byDay, 'month').map((b) => `| ${b.period} | ${usd(b.cost)} | ${b.count} |`).join('\n');
  const models = agg.byModel.slice(0, 8).map((m) => `| ${m.model} | ${usd(m.cost)} | ${m.count} |`).join('\n');
  return `---
type: cost-trend
date: ${dateStr}
cssclasses:
  - topic-dashboard
tags:
  - custo
---

# Custo — tendência

> Gerado por \`wendkeep cost --write\`. ${agg.count} sessão(ões) · total ${usd(agg.total)} · ${usd(agg.avg)}/sessão.

## Por mês

| Mês | Custo | Sessões |
|---|---|---|
${rows || '| — | — | — |'}

## Projeção (run-rate ${proj.windowDays}d)

Base: ${usd(proj.basisTotal)} nos últimos ${proj.windowDays} dias (${proj.basisDays} dia(s) com atividade) → **${usd(proj.dailyRate)}/dia**.
Projeção próximos ${proj.horizonDays} dias: **${usd(proj.projected)}**.

> Run-rate simples (média diária × horizonte), não previsão ajustada.

## Por modelo

| Modelo | Custo | Sessões |
|---|---|---|
${models || '| — | — | — |'}
`;
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
    e.file = f.slice(vaultBase.length + 1).replace(/\\/g, '/');
    entries.push(e);
  }
  const agg = aggregateCosts(entries);
  // Per-session list (main+sub), most expensive first — powers `cost --top`.
  agg.sessions = entries
    .map((e) => ({ file: e.file, date: e.date, cost: round4(e.mainCost + e.subCost) }))
    .sort((a, b) => b.cost - a.cost);
  return agg;
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
  if (argv[0] === 'rebuild') {
    const report = rebuildSessionCosts(vaultBase, {
      apply: argv.includes('--apply'),
      session: opt(argv, '--session') || '',
      limit: Number(opt(argv, '--limit')) || 0,
    });
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`cost rebuild (${report.mode}): ${report.scanned} lidas · ${report.changed} alteradas · ${report.unchanged} iguais · ${report.missing.length} sem fonte · ${report.errors.length} erros\n${report.mode === 'apply' ? 'Relatório: .brain/COST_REBUILD.json\n' : 'Nenhum arquivo foi alterado; use --apply para gravar.\n'}`);
    process.exit(report.ok ? 0 : 1);
  }
  const agg = collectVaultCost(vaultBase, { since: opt(argv, '--since') });

  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(agg, null, 2)}\n`); process.exit(0); }

  const topIdx = argv.indexOf('--top');
  if (topIdx >= 0) {
    const n = Number(argv[topIdx + 1]) || 10;
    process.stdout.write(`Sessões mais caras (top ${n} de ${agg.count}):\n`);
    for (const s of agg.sessions.slice(0, n)) process.stdout.write(`  ${usd(s.cost).padStart(11)}  ${s.date || '?'}  ${s.file}\n`);
    process.exit(0);
  }

  const trendIdx = argv.indexOf('--trend');
  if (trendIdx >= 0) {
    const bucket = ['day', 'week', 'month'].includes(argv[trendIdx + 1]) ? argv[trendIdx + 1] : 'month';
    const proj = projectSpend(agg.byDay);
    process.stdout.write(`Tendência de custo (por ${bucket}):\n`);
    for (const b of trendBuckets(agg.byDay, bucket)) process.stdout.write(`  ${b.period}  ${usd(b.cost).padStart(11)}  (${b.count})\n`);
    process.stdout.write(`\nRun-rate ${proj.windowDays}d: ${usd(proj.dailyRate)}/dia · projeção ${proj.horizonDays}d: ${usd(proj.projected)} (base ${usd(proj.basisTotal)} em ${proj.basisDays} dia(s))\n`);
    process.exit(0);
  }

  if (argv.includes('--write')) {
    const proj = projectSpend(agg.byDay);
    const rel = '00-Custo.md';
    writeFileSync(join(vaultBase, rel), renderTrendNote(agg, proj, today()), 'utf8');
    process.stdout.write(`cost --write: ${rel} (nota de tendência gerada)\n`);
    process.exit(0);
  }

  process.stdout.write(`Custo total (vault): ${usd(agg.total)} — ${agg.count} sessão(ões) · ${usd(agg.avg)}/sessão\n`);
  process.stdout.write(`  main: ${usd(agg.main)} · subagents: ${usd(agg.sub)}\n`);
  if (agg.wasted) process.stdout.write(`  desperdiçado (runs killed/failed): ${usd(agg.wasted)}\n`);
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
