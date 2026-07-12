#!/usr/bin/env node
// UserPromptSubmit hook. Dois papéis, ambos quiet-by-default (a maioria dos prompts não injeta nada):
//   1. Com changes abertas: re-injeta <open_changes_ping> (backlog completo) SÓ quando o estado
//      mudou desde a última injeção (hash em sentinela por sessão).
//   2. Sem changes abertas: prompt com cara de tarefa ganha <wk_skill_gate> mandando invocar a
//      Skill wk-workflow ANTES de editar — 1x por sessão. É o empurrão de ativação da skill.
// Fail-open; brain-inject grava a sentinela ctx no SessionStart para não duplicar no 1º prompt.
import { pathToFileURL } from 'node:url';
import { getVaultBase, readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { changeCtxState, readSentinel, renderOpenChanges, writeSentinel } from './change-core.mjs';
import { resolveSessionEntry } from './session-identity.mjs';

// Conservador de propósito: verbos de tarefa comuns (pt+en) + tamanho mínimo. Falso-negativo
// custa só o nudge; falso-positivo em pergunta curta viraria ruído.
const TASK_RE = /\b(implement\w*|cri[ae]\w*|corrig\w*|conserta\w*|refator\w*|adicion\w*|remov\w*|migr\w*|constru\w*|desenvolv\w*|fix\w*|add|build\w*|create\w*|refactor\w*|develop\w*|escrev\w*|write)\b/i;

export function looksLikeTask(prompt) {
  const p = String(prompt || '').trim();
  return p.length >= 20 && TASK_RE.test(p);
}

// Retorna { context, hash? } quando há algo a injetar; null = silêncio.
export function buildChangePing(vaultBase, sessionId, prompt = '', changeSlug = '') {
  const st = changeCtxState(vaultBase);
  if (st) {
    if (readSentinel(vaultBase, 'ctx', sessionId) === st.hash) return null;
    writeSentinel(vaultBase, 'ctx', sessionId, st.hash);
    const focus = changeSlug ? `\n<session_change>Change vinculada a esta sessão: ${changeSlug}.</session_change>` : '';
    return { context: `${renderOpenChanges(st, { tag: 'open_changes_ping' })}${focus}`, hash: st.hash };
  }
  // Sem changes abertas: gate de skill para prompt-tarefa, 1x por sessão.
  if (!looksLikeTask(prompt)) return null;
  if (readSentinel(vaultBase, 'gate', sessionId)) return null;
  writeSentinel(vaultBase, 'gate', sessionId);
  return {
    context: [
      '<wk_skill_gate>',
      'Este pedido parece uma tarefa de código e NÃO há change ativa no vault. Antes de editar qualquer arquivo, invoque a Skill wk-workflow — ela orquestra o loop a2 (`wendkeep change new <slug>` → tarefas → verify → archive) e registra tudo no vault. Ignore apenas se a mudança for trivial (typo, 1 linha).',
      '</wk_skill_gate>',
    ].join('\n'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const vaultBase = getVaultBase(input);
    const { identity, entry } = resolveSessionEntry(vaultBase, input);
    const sid = identity.state === 'resolved' ? identity.canonicalConversationId : (input.session_id || input.sessionId || '');
    const ping = buildChangePing(vaultBase, sid, input.prompt || '', entry?.change_slug || '');
    if (!ping) { writeHookOutput({}); }
    else writeHookOutput({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ping.context } });
  } catch {
    writeHookOutput({});
  }
}
