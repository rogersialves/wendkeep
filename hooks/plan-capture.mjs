#!/usr/bin/env node
// PostToolUse hook (matcher: ExitPlanMode). A ponte determinística entre o plan mode do Claude
// Code e o vault: quando o usuário APROVA um plano, o plano vira registro — anexado à change
// ativa, ou uma change nova criada e preenchida a partir dele (proposta do Contexto, design do
// corpo, tarefas dos checkboxes). Não depende de a LLM lembrar do processo. Rejeição = no-op.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDate, getVaultBase, readHookInput, slugify, writeHookOutput } from './obsidian-common.mjs';
import { activeChange, newChange } from './change-core.mjs';
import { getLocale } from './locale.mjs';

// O plano aprovado chega por um de três canais, conforme a versão do Claude Code:
// tool_input.plan (legado), o bloco "## Approved Plan" do tool_response, ou o arquivo de plano
// citado em "saved to: <path>". Rejeição (ou ausência de sinal de aprovação) → null.
export function extractPlan(input) {
  const tr = input?.tool_response ?? input?.toolResponse ?? '';
  const resp = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
  if (/doesn'?t want to proceed|user rejected|rejected the plan/i.test(resp)) return null;
  if (!/approved (your |the )?plan|Approved Plan/i.test(resp)) return null;
  const direct = input?.tool_input?.plan ?? input?.toolInput?.plan;
  if (direct && String(direct).trim()) return String(direct);
  const marker = resp.match(/## Approved Plan[^\n]*:\s*\n([\s\S]+)$/);
  if (marker && marker[1].trim()) return marker[1].trim();
  const path = resp.match(/saved to:\s*([^\n]+\.md)/i);
  if (path) { try { return readFileSync(path[1].trim(), 'utf8'); } catch { /* arquivo inacessível */ } }
  return null;
}

export function planSlug(plan) {
  const h1 = String(plan || '').match(/^#\s+(.+)$/m);
  return h1 ? slugify(h1[1], 'plano-aprovado', 60) : 'plano-aprovado';
}

function sectionBody(plan, headings) {
  for (const h of headings) {
    const m = String(plan).match(new RegExp(`^##\\s+${h}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'm'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

// Checkboxes do plano viram tarefas numeradas 1.N (estado [x] preservado). [] quando não há.
export function planTasks(plan) {
  const boxes = [...String(plan || '').matchAll(/^\s*-\s+\[( |x)\]\s+(.+)$/gm)];
  return boxes.map((m, i) => `- [${m[1]}] 1.${i + 1} ${m[2].trim()}`);
}

export function capturePlan(vaultBase, input) {
  const plan = extractPlan(input);
  if (!plan) return null;
  const loc = getLocale(vaultBase);
  const en = loc.id === 'en';
  const dateStr = formatDate(new Date());
  const rawNote = `---\ntype: plan\ndate: ${dateStr}\ntags:\n  - plano\n---\n\n${plan.trim()}\n`;

  const active = activeChange(vaultBase);
  if (active) {
    const dir = join(vaultBase, loc.folders.changes, active);
    writeFileSync(join(dir, 'plano-aprovado.md'), rawNote, 'utf8');
    return {
      slug: active, created: false,
      context: `<plan_captured>\n${en
        ? `Approved plan attached to the active change "${active}" (plano-aprovado.md). Sync tarefas.md with the plan's tasks.`
        : `Plano aprovado anexado à change ativa "${active}" (plano-aprovado.md). Sincronize tarefas.md com as tarefas do plano.`}\n</plan_captured>`,
    };
  }

  const slug = planSlug(plan);
  newChange(vaultBase, slug, { dateStr });
  const dir = join(vaultBase, loc.folders.changes, slug);
  const ctx = sectionBody(plan, ['Contexto', 'Context']) || plan.trim().split('\n').slice(0, 6).join('\n');
  writeFileSync(join(dir, 'proposta.md'), `---
type: change
status: active
date: ${dateStr}
cssclasses:
  - topic-change
tags:
  - mudanca
source: []
specs: []
---

# ${slug}

${en ? '## Why' : '## Por quê'}

${ctx}

${en ? '## What changes' : '## O que muda'}

${en ? 'See design.md and plano-aprovado.md (captured from the approved plan-mode plan).' : 'Ver design.md e plano-aprovado.md (capturados do plano aprovado no plan mode).'}
`, 'utf8');
  writeFileSync(join(dir, 'design.md'), `# ${slug} — design\n\n${plan.trim()}\n`, 'utf8');
  const tasks = planTasks(plan);
  if (tasks.length) writeFileSync(join(dir, 'tarefas.md'), `# ${slug} — ${en ? 'tasks' : 'tarefas'}\n\n${tasks.join('\n')}\n`, 'utf8');
  writeFileSync(join(dir, 'plano-aprovado.md'), rawNote, 'utf8');
  return {
    slug, created: true,
    context: `<plan_captured>\n${en
      ? `Approved plan recorded in the vault: change "${slug}" created and set active (${loc.folders.changes}/${slug}/). Review tarefas.md${tasks.length ? '' : ' — the plan had no checkboxes, fill the tasks'} and follow the a2 loop (wk-tdd per task, \`wendkeep change done <id>\`, \`wendkeep verify\`).`
      : `Plano aprovado — change "${slug}" registrada no vault e ativa (${loc.folders.changes}/${slug}/). Revise tarefas.md${tasks.length ? '' : ' — o plano não tinha checkboxes, preencha as tarefas'} e siga o loop a2 (wk-tdd por tarefa, \`wendkeep change done <id>\`, \`wendkeep verify\`).`}\n</plan_captured>`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const r = capturePlan(getVaultBase(input), input);
    if (!r) { writeHookOutput({}); }
    else writeHookOutput({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.context } });
  } catch {
    writeHookOutput({});
  }
}
