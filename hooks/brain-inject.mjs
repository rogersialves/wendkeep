// .agent/hooks/brain-inject.mjs
// Injeção da camada quente no SessionStart (Claude/Codex/Copilot): CORE curado +
// DIGEST auto + 1-linha pointer do recall + backlog completo de changes. Nunca derruba o hook.
// Uso (hook): node .agent/hooks/brain-inject.mjs   (input JSON via stdin)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getVaultBase, readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { brainDir } from './brain-core.mjs';
import { buildActiveChangeInjection, changeCtxState, writeSentinel } from './change-core.mjs';
import { buildLessonsInjection } from './lessons-core.mjs';
import { getLocale } from './locale.mjs';

// The process ROUTER — the enforcement layer. The wk-* skills are passive files; without a
// standing instruction the model plans in chat, leaves the change scaffold raw and forces the
// gate (seen in production: change archived with `(primeira tarefa)` open, via --force). This
// block is injected EVERY session so planning always routes through the a2 loop.
function processRouter(localeId) {
  if (localeId === 'en') {
    return [
      '<wk_process>',
      'Spec-driven process (mandatory for any non-trivial task): INVOKE the wk-workflow Skill BEFORE editing any file.',
      '1. Plan: invoke the wk-brainstorming Skill (approved design) → wk-planning (task plan).',
      '2. Record: `wendkeep change new <slug>` and FILL proposta/design/tasks. Resolve `spec_impact`: `required` needs `specs/<capability>/spec.md` + [req:ID]; `none` needs a reason. Never leave pending/placeholders.',
      '3. Implement: wk-tdd per task; tick `- [x]` as you finish. Something broke? wk-debugging.',
      '4. Close: `wendkeep verify` (+ `--deep` + the wk-verify Skill) → `wendkeep change archive`.',
      'NEVER `archive --force` on your own — a red gate means pending work; --force is the user\'s call, not yours. Dead end? `wendkeep change abandon`.',
      '</wk_process>',
    ].join('\n');
  }
  return [
    '<wk_process>',
    'Processo spec-driven (obrigatório em tarefa não-trivial): INVOQUE a Skill wk-workflow ANTES de editar qualquer arquivo.',
    '1. Planejar: invoque a Skill wk-brainstorming (design aprovado) → wk-planning (plano de tarefas).',
    '2. Registrar: `wendkeep change new <slug>` e PREENCHA proposta/design/tarefas. Resolva `spec_impact`: `required` exige `specs/<capability>/spec.md` + [req:ID]; `none` exige justificativa. Nunca deixe pending/placeholders.',
    '3. Implementar: wk-tdd por tarefa; marque `- [x]` ao concluir. Quebrou algo? wk-debugging.',
    '4. Fechar: `wendkeep verify` (+ `--deep` + Skill wk-verify) → `wendkeep change archive`.',
    'PROIBIDO `archive --force` por conta própria — gate vermelho significa trabalho pendente; --force é decisão do usuário, não sua. Beco sem saída? `wendkeep change abandon`.',
    '</wk_process>',
  ].join('\n');
}

const MAX_LINES = 45; // CORE ≤25 + DIGEST ≤15 + folga; salvaguarda se o CORE crescer à mão

export function buildInjection(vaultBase) {
  const dir = brainDir(vaultBase);
  const read = (name) => {
    try { return readFileSync(join(dir, name), 'utf8').trim(); } catch { return ''; }
  };
  const pointer = 'Memória profunda sob demanda: /brain-recall <tópico> (índice .brain/index.jsonl).';
  // Quando CORE e DIGEST não existem, ''.split('\n') vira [''] — o filter derruba essa
  // linha vazia para o caso "só pointer" ficar com exatamente 3 linhas.
  let lines = [read('CORE.md'), read('DIGEST.md')].filter(Boolean).join('\n\n').split('\n').filter((l, i, a) => a.length > 1 || l);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    lines.push('*…truncado pelo budget — fonte completa: .brain/CORE.md + .brain/DIGEST.md*');
  }
  const brain = ['<brain_memory>', ...lines, pointer, '</brain_memory>'].join('\n');
  const router = processRouter(getLocale(vaultBase).id);
  const change = buildActiveChangeInjection(vaultBase);
  const lessons = buildLessonsInjection(vaultBase);
  return [brain, router, change, lessons].filter(Boolean).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const vaultBase = getVaultBase(input);
    writeHookOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildInjection(vaultBase),
      },
    });
    // Sentinela do change-context: o backlog completo acabou de ser injetado aqui, então o hook
    // UserPromptSubmit não precisa re-pingar no 1º prompt. Bônus — nunca derruba a injeção.
    try {
      const st = changeCtxState(vaultBase);
      if (st) writeSentinel(vaultBase, 'ctx', input.session_id || input.sessionId || '', st.hash);
    } catch { /* sentinela é bônus */ }
  } catch (error) {
    process.stderr.write(`[brain] inject falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
