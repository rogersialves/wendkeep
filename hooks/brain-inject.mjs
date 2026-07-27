// .agent/hooks/brain-inject.mjs
// Injeção da camada quente no SessionStart (Claude/Codex/Copilot): CORE curado +
// SHARED operacional no v2; DIGEST fica só no fallback legado/recall. Nunca derruba o hook.
// Uso (hook): node .agent/hooks/brain-inject.mjs   (input JSON via stdin)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { brainDir } from './brain-core.mjs';
import { buildActiveChangeInjection, changeCtxState, writeSentinel } from './change-core.mjs';
import { buildLessonsInjection } from './lessons-core.mjs';
import { getLocale } from './locale.mjs';
import { resolveSessionEntry } from './session-identity.mjs';
import { sanitizeMemoryText, validateSharedMemory } from './memory-schema.mjs';
import { detectMemoryMode } from './memory-mode.mjs';
import {
  hookProfilePolicy,
  profileSentinelId,
  resolveHookOperatingProfile,
} from './operating-profile-runtime.mjs';
import { assertVaultPathSafe } from './vault-path-safety.mjs';
import { validateCore } from '../src/validate-core.mjs';

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

const INJECTION_LIMITS = Object.freeze({
  totalBytes: 24 * 1024,
  lineChars: 320,
  coreBytes: 4 * 1024,
  sharedBytes: 6 * 1024,
  attentionBytes: 1024,
  recallBytes: 512,
});

function aliasBoundaryError(error) {
  return error?.code === 'VAULT_PATH_UNSAFE'
    && /link simbólico|junction|reparse|hardlink|nlink|redirecion|escapa logicamente/i
      .test(String(error?.message || error));
}

function readMemoryFile(vaultBase, name) {
  const path = join(brainDir(vaultBase), name);
  const label = `camada de memória ${name}`;
  try {
    let checked = assertVaultPathSafe(vaultBase, path, { expectedType: 'file', label });
    if (!checked.exists) return '';
    checked = assertVaultPathSafe(vaultBase, checked.target, {
      allowMissing: false, expectedType: 'file', label,
    });
    return readFileSync(checked.target, 'utf8').replace(/\r\n/g, '\n').trim();
  }
  catch (error) {
    if (aliasBoundaryError(error)) throw error;
    return '';
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function xmlAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeError(layer, reasons) {
  const detail = sanitizeMemoryText((reasons || []).join('; ') || 'arquivo ausente ou inválido')
    .replace(/\s+/g, ' ');
  const max = 260;
  const visible = detail.length <= max ? detail : `${detail.slice(0, max - 20)} … [erro resumido]`;
  return `<wk_memory_error layer="${layer}" repair="wendkeep memory status --gate">${visible}</wk_memory_error>`;
}

export function profileRuntimeError(diagnostic) {
  if (!diagnostic) return '';
  const code = diagnostic.code || 'WENDKEEP_PROFILE_RESOLUTION_ERROR';
  const detail = sanitizeMemoryText(diagnostic.message || String(diagnostic))
    .replace(/\s+/g, ' ')
    .trim();
  const max = 320;
  const visible = detail.length <= max ? detail : `${detail.slice(0, max - 20)} … [erro resumido]`;
  return `<wk_profile_error code="${xmlAttr(code)}" fallback="GOVERN" repair="wendkeep doctor">${visible}</wk_profile_error>`;
}

function validateCoreLayer(raw) {
  if (!raw) return { ok: false, rendered: safeError('core', ['CORE.md ausente']) };
  const sanitized = sanitizeMemoryText(raw);
  const validation = validateCore(raw);
  const errors = [...validation.errors];
  if (sanitized !== raw) errors.push('CORE exige sanitização de segredo, PII, path local ou payload de harness');
  if (byteLength(sanitized) > INJECTION_LIMITS.coreBytes) {
    errors.push(`CORE excede ${INJECTION_LIMITS.coreBytes} bytes`);
  }
  sanitized.split('\n').forEach((line, index) => {
    if (line.length > INJECTION_LIMITS.lineChars) errors.push(`CORE linha ${index + 1} excede ${INJECTION_LIMITS.lineChars} caracteres`);
  });
  return errors.length
    ? { ok: false, rendered: safeError('core', errors) }
    : { ok: true, rendered: sanitized };
}

function validateSharedLayer(raw) {
  if (!raw) return { ok: false, rendered: safeError('shared', ['SHARED_MEMORY.md ausente']) };
  // Boundary sanitization is deliberately repeated even though the projector already sanitizes.
  const sanitized = sanitizeMemoryText(raw);
  const validation = validateSharedMemory(raw);
  return validation.ok
    ? { ok: true, rendered: sanitized, metadata: validation.metadata }
    : { ok: false, rendered: safeError('shared', validation.errors), metadata: validation.metadata };
}

function buildV2Memory(vaultBase) {
  const core = validateCoreLayer(readMemoryFile(vaultBase, 'CORE.md'));
  const shared = validateSharedLayer(readMemoryFile(vaultBase, 'SHARED_MEMORY.md'));
  const revision = shared.metadata?.revision ?? 'unknown';
  const stateHash = shared.metadata?.state_hash ?? 'unknown';
  const attention = [core, shared].every((layer) => layer.ok)
    ? 'none'
    : 'Memória degradada: repare os erros bloqueantes acima antes de confiar no estado operacional.';
  const pointer = 'Memória profunda sob demanda: /brain-recall <tópico> (índice .brain/index.jsonl; DIGEST é apenas recall).';
  const block = [
    `<brain_memory version="2" revision="${xmlAttr(revision)}" state_hash="${xmlAttr(stateHash)}">`,
    '<wk_memory_contract>',
    'CORE é canônico e SHARED é operacional; nenhum deles pode ser inferido de wikilinks ou truncado.',
    '</wk_memory_contract>',
    '<wk_core authority="canonical">',
    core.rendered,
    '</wk_core>',
    '<wk_shared_state authority="operational">',
    shared.rendered,
    '</wk_shared_state>',
    '<wk_memory_attention>',
    attention,
    '</wk_memory_attention>',
    '<wk_recall>',
    pointer,
    '</wk_recall>',
    '</brain_memory>',
  ].join('\n');
  // Layer validation above makes this defensive guard observable without ever prefix-slicing.
  if (byteLength(block) > (INJECTION_LIMITS.coreBytes + INJECTION_LIMITS.sharedBytes
      + INJECTION_LIMITS.attentionBytes + INJECTION_LIMITS.recallBytes + 2048)) {
    return [
      `<brain_memory version="2" revision="${xmlAttr(revision)}" state_hash="${xmlAttr(stateHash)}">`,
      safeError('envelope', ['envelope de memória excedeu o budget reservado']),
      '</brain_memory>',
    ].join('\n');
  }
  return block;
}

function validateLegacyLayer(raw, layer, { maxLines, maxBytes }) {
  if (!raw) return '';
  const sanitized = sanitizeMemoryText(raw);
  const lines = sanitized.split('\n');
  const errors = [];
  if (lines.length > maxLines) errors.push(`${layer} excede ${maxLines} linhas`);
  if (byteLength(sanitized) > maxBytes) errors.push(`${layer} excede ${maxBytes} bytes`);
  if (lines.some((line) => line.length > INJECTION_LIMITS.lineChars)) errors.push(`${layer} contém linha acima de ${INJECTION_LIMITS.lineChars} caracteres`);
  return errors.length ? safeError(layer.toLowerCase(), errors) : sanitized;
}

function buildLegacyMemory(vaultBase) {
  const coreRaw = readMemoryFile(vaultBase, 'CORE.md');
  const coreValidation = coreRaw ? validateCoreLayer(coreRaw) : { ok: true, rendered: '' };
  const digest = validateLegacyLayer(readMemoryFile(vaultBase, 'DIGEST.md'), 'DIGEST', { maxLines: 15, maxBytes: 4096 });
  const pointer = 'Memória profunda sob demanda: /brain-recall <tópico> (índice .brain/index.jsonl).';
  return [
    '<brain_memory>',
    '<wk_memory_legacy_warning>Vault legado: CORE+DIGEST será removido após uma release; migre para SHARED_MEMORY v2.</wk_memory_legacy_warning>',
    coreValidation.rendered,
    digest,
    pointer,
    '</brain_memory>',
  ].filter(Boolean).join('\n');
}

function joinInjection(parts) {
  return sanitizeMemoryText(parts.filter(Boolean).join('\n'));
}

function boundAncillaryText(text, reservedChars = 0) {
  if (text.length + reservedChars <= INJECTION_LIMITS.lineChars) return text;
  const marker = ' … [linha resumida pelo budget]';
  return `${text.slice(0, INJECTION_LIMITS.lineChars - reservedChars - marker.length)}${marker}`;
}

function budgetNotice(priority, layer, message) {
  return `<wk_budget_notice priority="${priority}" layer="${layer}">${message}</wk_budget_notice>`;
}

export function buildInjection(vaultBase, input = {}, { profile = 'GOVERN', bindingError = null } = {}) {
  const brain = detectMemoryMode(vaultBase).mode === 'v2'
    ? buildV2Memory(vaultBase)
    : buildLegacyMemory(vaultBase);
  const policy = hookProfilePolicy(profile);
  const lessons = buildLessonsInjection(vaultBase, { maxLineChars: INJECTION_LIMITS.lineChars });
  const profileNotice = profileRuntimeError(bindingError);

  // OFF keeps only the persistent project memory layers. No process/change/gate state crosses
  // the vault -> harness boundary in this profile.
  if (!policy.harness) return joinInjection([brain, profileNotice, lessons]);

  // FLOW executes and validates without demanding a change. Explicitly opened changes remain
  // visible below, but the standing change router would contradict that contract.
  const router = policy.requiresChange ? processRouter(getLocale(vaultBase).id) : '';
  const { identity, entry } = resolveSessionEntry(vaultBase, input);
  const focus = identity.state === 'resolved' && entry?.change_slug
    ? `<session_change>${boundAncillaryText(`Change vinculada a esta sessão: ${entry.change_slug}. Este vínculo prevalece para writes automáticos; todas as pendências continuam visíveis acima.`, '<session_change></session_change>'.length)}</session_change>`
    : '';
  const allChanges = buildActiveChangeInjection(vaultBase, { maxLineChars: INJECTION_LIMITS.lineChars });

  // Global priority is deterministic: memory/router/focus, then changes, then lessons.
  let output = joinInjection([brain, profileNotice, router, focus, allChanges, lessons]);
  if (byteLength(output) <= INJECTION_LIMITS.totalBytes) return output;

  // First pressure step: lessons are fully removable and remain available in the vault.
  const lessonsEvicted = budgetNotice(1, 'lessons', 'Lessons omitidas primeiro pelo budget global.');
  output = joinInjection([brain, profileNotice, router, focus, allChanges, lessonsEvicted]);
  if (byteLength(output) <= INJECTION_LIMITS.totalBytes) return output;

  // Second pressure step: non-current changes leave the hot context before the current one.
  const nonCurrentEvicted = budgetNotice(2, 'non-current-changes', 'Changes não atuais omitidas depois das lessons.');
  const currentChange = buildActiveChangeInjection(vaultBase, {
    currentOnly: true,
    maxLineChars: INJECTION_LIMITS.lineChars,
  });
  output = joinInjection([brain, profileNotice, router, focus, currentChange, lessonsEvicted, nonCurrentEvicted]);
  if (byteLength(output) <= INJECTION_LIMITS.totalBytes) return output;

  // Last step caps only the current change block, with an explicit marker and closed wrapper.
  const currentSummarized = budgetNotice(3, 'current-change', 'Change atual resumida por último; blocker e início da fila foram preservados.');
  const fixed = joinInjection([brain, profileNotice, router, focus, lessonsEvicted, nonCurrentEvicted, currentSummarized]);
  const remaining = Math.max(512, INJECTION_LIMITS.totalBytes - byteLength(fixed) - 1);
  const boundedCurrent = buildActiveChangeInjection(vaultBase, {
    currentOnly: true,
    maxBytes: remaining,
    maxLineChars: INJECTION_LIMITS.lineChars,
  });
  return joinInjection([
    brain,
    profileNotice,
    router,
    focus,
    lessonsEvicted,
    nonCurrentEvicted,
    boundedCurrent,
    currentSummarized,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({ input });
    const vaultBase = runtime.vaultBase;
    writeHookOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildInjection(vaultBase, input, {
          profile: runtime.profile,
          bindingError: runtime.bindingError,
        }),
      },
    });
    // Sentinela do change-context: o backlog completo acabou de ser injetado aqui, então o hook
    // UserPromptSubmit não precisa re-pingar no 1º prompt. Bônus — nunca derruba a injeção.
    if (runtime.policy.harness && !runtime.bindingError) try {
      const st = changeCtxState(vaultBase);
      const { identity } = runtime;
      const sid = identity.state === 'resolved' ? identity.canonicalConversationId : (input.session_id || input.sessionId || '');
      if (st) {
        writeSentinel(vaultBase, 'ctx', profileSentinelId(sid, runtime.profile), st.hash);
      }
    } catch { /* sentinela é bônus */ }
  } catch (error) {
    process.stderr.write(`[brain] inject falhou: ${error.message}\n`);
    writeHookOutput({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: profileRuntimeError(error),
      },
    });
  }
}
