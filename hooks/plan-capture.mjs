#!/usr/bin/env node
// PostToolUse hook (matcher: ExitPlanMode). A ponte determinística entre o plan mode do Claude
// Code e o vault: quando o usuário APROVA um plano, o plano vira registro — anexado à change
// ativa, ou uma change nova criada e preenchida a partir dele (proposta do Contexto, design do
// corpo, tarefas dos checkboxes). Não depende de a LLM lembrar do processo. Rejeição = no-op.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findActiveSessionByTranscript,
  formatDate,
  getVaultBase,
  readControl,
  readHookInput,
  slugify,
  wikilinkFromRel,
  writeHookOutput,
} from './obsidian-common.mjs';
import { activeChange, newChange } from './change-core.mjs';
import { getLocale } from './locale.mjs';

// O plano aprovado chega por um de três canais, conforme a versão do Claude Code:
// tool_input.plan (legado), o bloco "## Approved Plan" do tool_response, ou o arquivo de plano
// citado em "saved to: <path>". Rejeição (ou ausência de sinal de aprovação) → null.
export function extractPlan(input) {
  const tr = input?.tool_response ?? input?.toolResponse ?? '';
  const resp = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
  if (/doesn'?t want to proceed|user rejected|rejected the plan/i.test(resp)) return null;
  const direct = input?.tool_input?.plan ?? input?.toolInput?.plan;
  // Claude Code atual entrega o plano aprovado como objeto estruturado no PostToolUse.
  // Esse evento só ocorre após sucesso; flags negativas explícitas continuam no-op.
  if (tr && typeof tr === 'object') {
    if (tr.approved === false || tr.rejected === true || tr.cancelled === true) return null;
    const structured = tr.plan ?? direct;
    if (structured && String(structured).trim()) return String(structured);
    const structuredPath = tr.filePath ?? tr.planFilePath;
    if (structuredPath) { try { return readFileSync(String(structuredPath), 'utf8'); } catch { /* inacessível */ } }
    return null;
  }
  if (!/approved (your |the )?plan|Approved Plan/i.test(resp)) return null;
  if (direct && String(direct).trim()) return String(direct);
  const marker = resp.match(/## Approved Plan[^\n]*:\s*\n([\s\S]+)$/);
  if (marker && marker[1].trim()) return marker[1].trim();
  const path = resp.match(/saved to:\s*([^\n]+\.md)/i);
  if (path) { try { return readFileSync(path[1].trim(), 'utf8'); } catch { /* arquivo inacessível */ } }
  return null;
}

function planIndex(slug) {
  return `---\ntype: plan-index\ntags:\n  - plano\n---\n\n# ${slug} — planos aprovados\n`;
}

export function persistApprovedPlan(dir, slug, rawNote, plan, dateStr) {
  const hash = createHash('sha256').update(String(plan)).digest('hex').slice(0, 12);
  const snapshotsDir = join(dir, 'planos');
  mkdirSync(snapshotsDir, { recursive: true });
  const snapshot = join(snapshotsDir, `${hash}.md`);
  if (!existsSync(snapshot)) writeFileSync(snapshot, rawNote, 'utf8');

  const indexPath = join(dir, 'plano-aprovado.md');
  let index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : planIndex(slug);
  const entry = `- [[planos/${hash}|${dateStr} — ${hash}]]`;
  if (!index.includes(`[[planos/${hash}|`)) {
    index = `${index.trimEnd()}\n\n${entry}\n`;
    writeFileSync(indexPath, index, 'utf8');
  }
  return { hash, snapshot };
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
  const transcriptPath = input?.transcript_path ?? input?.transcriptPath ?? '';
  const sessionRel = findActiveSessionByTranscript(vaultBase, transcriptPath)?.session_file
    || readControl(vaultBase).session_file
    || '';

  const active = activeChange(vaultBase);
  if (active) {
    const dir = join(vaultBase, loc.folders.changes, active);
    persistApprovedPlan(dir, active, rawNote, plan, dateStr);
    return {
      slug: active, created: false,
      context: `<plan_captured>\n${en
        ? `Approved plan attached to the active change "${active}" (plano-aprovado.md). Sync tarefas.md with the plan's tasks.`
        : `Plano aprovado anexado à change ativa "${active}" (plano-aprovado.md). Sincronize tarefas.md com as tarefas do plano.`}\n</plan_captured>`,
    };
  }

  const slug = planSlug(plan);
  newChange(vaultBase, slug, { dateStr, sessionRel });
  const dir = join(vaultBase, loc.folders.changes, slug);
  const ctx = sectionBody(plan, ['Contexto', 'Context']) || plan.trim().split('\n').slice(0, 6).join('\n');
  const source = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  writeFileSync(join(dir, 'proposta.md'), `---
type: change
status: active
date: ${dateStr}
cssclasses:
  - topic-change
tags:
  - mudanca
source:${source}
spec_impact: pending
spec_impact_reason: ""
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
  persistApprovedPlan(dir, slug, rawNote, plan, dateStr);
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
  } catch (error) {
    process.stderr.write(`[wendkeep] plan-capture falhou: ${error.message}\n`);
    writeHookOutput({ hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `<plan_capture_error>O plano aprovado não foi persistido: ${error.message}</plan_capture_error>`,
    } });
  }
}
