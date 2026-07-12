// `wendkeep stats` — one shareable line about what the vault has captured. For the npm page,
// a README badge line, or a tweet. Read-only; reuses the cost aggregation.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { collectVaultCost } from './cost.mjs';

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const num = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Pure: derive the shareable stats from a collectVaultCost aggregate.
export function statsFrom(agg) {
  const days = (agg.byDay || []).map((d) => d.date).filter((d) => d && d !== '?').sort();
  return {
    sessions: agg.count,
    prompts: agg.prompts || 0,
    cost: agg.total,
    models: (agg.byModel || []).filter((m) => m.model !== 'subagents (legado, modelo desconhecido)').length,
    firstDay: days[0] || '',
    lastDay: days[days.length - 1] || '',
    spanDays: days.length,
  };
}

export function statsLine(s) {
  // "dias ativos" = distinct days WITH activity, not the calendar span (shown in parens).
  const span = s.firstDay && s.lastDay ? ` · ${s.spanDays} dias ativos (${s.firstDay}→${s.lastDay})` : '';
  return `wendkeep: ${num(s.sessions)} sessão(ões) · ${num(s.prompts)} prompts · ${usd(s.cost)} capturado${span} · ${s.models} modelo(s)`;
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

export function runStats(argv) {
  const vaultRaw = opt(argv, '--vault') || process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultRaw) { process.stderr.write('wendkeep stats: no vault (--vault or OBSIDIAN_VAULT_PATH).\n'); process.exit(2); }
  const vaultBase = isAbsolute(vaultRaw) ? vaultRaw : resolve(process.cwd(), vaultRaw);
  if (!existsSync(vaultBase)) { process.stderr.write(`wendkeep stats: vault not found: ${vaultBase}\n`); process.exit(2); }
  const s = statsFrom(collectVaultCost(vaultBase));
  if (argv.includes('--json')) { process.stdout.write(`${JSON.stringify(s, null, 2)}\n`); process.exit(0); }
  process.stdout.write(`${statsLine(s)}\n`);
  process.exit(0);
}
