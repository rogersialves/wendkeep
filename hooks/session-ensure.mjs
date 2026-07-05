#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  controlPath,
  ensureDir,
  formatDate,
  formatHourMinute,
  formatLocalIso,
  formatTime,
  getVaultBase,
  warnIfDefaultVault,
  debugLog,
  readControl,
  readHookInput,
  readSessionRegistry,
  sessionFileName,
  sessionFolderRel,
  sessionSummaryFromInput,
  isUsableSummary,
  providerMeta,
  shouldReuseActiveSession,
  isPlaceholderSessionFile,
  toVaultRelative,
  uniquePath,
  upsertSessionRegistry,
  VAULT_COMPLEMENT_RULES,
  wikilinkFromRel,
  writeControl,
  writeHookOutput,
  yamlQuote,
} from './obsidian-common.mjs';

function sessionIdFromInput(input) {
  return input.session_id || input.sessionId || input.codex_session_id || '';
}

function buildSessionContent({ relPath, now, summary = 'session', reason = 'Sessão criada automaticamente pelo hook UserPromptSubmit.' }) {
  const date = formatDate(now);
  const startedAt = formatLocalIso(now);
  const titleTime = formatTime(now).slice(0, 5);
  const objective = summary === 'session' ? 'Preencher durante a sessão.' : summary;
  const provider = providerMeta();

  return `---
type: session
date: ${date}
started_at: ${startedAt}
ended_at:
provider: ${provider.id}
status: active
summary: ${yamlQuote(summary)}
cssclasses:
  - topic-session
tags:
  - sessao
  - ${provider.tag}
  - llm
source: ${provider.source}
related:
---

# ${titleTime} - ${summary}

## Metadados

- **Provider:** ${provider.label}
- **Início:** ${startedAt}
- **Fim:**
- **Status:** active
- **Arquivo:** \`${relPath}\`

## Objetivo da sessão

> ${objective}

## Resumo vivo

> Esta seção pode ser atualizada ao longo da sessão, mas o histórico de iterações deve ser preservado.

## Iterações

### ${titleTime} - Início da sessão

${reason}

## Decisões geradas nesta sessão

Nenhuma decisão registrada ainda.

## Bugs gerados nesta sessão

Nenhum bug registrado ainda.

## Aprendizados gerados nesta sessão

Nenhum aprendizado registrado ainda.

## Arquivos consultados

Nenhum arquivo registrado ainda.

## Arquivos criados ou alterados

Nenhum arquivo registrado ainda.

## Pendências

Nenhuma pendência identificada automaticamente.

## Encerramento

Sessão ainda em andamento.
`;
}

function allocateSessionPath(vaultBase, now, summary = 'session') {
  const folderRel = sessionFolderRel(now);
  const folderAbs = join(vaultBase, folderRel);
  ensureDir(folderAbs);

  const baseName = sessionFileName(now, summary);
  const filePath = uniquePath(join(folderAbs, baseName));
  return {
    absPath: filePath,
    relPath: toVaultRelative(vaultBase, filePath),
  };
}

function buildAdditionalContext({ relPath, startedAt, vaultBase }) {
  const controlRel = toVaultRelative(vaultBase, controlPath(vaultBase));
  return [
    '<obsidian_session>',
    `Sessão Obsidian ativa: ${relPath}`,
    `Controle atualizado: ${controlRel}`,
    `Início: ${startedAt}`,
    '',
    'Use a sessão ativa como log desta conversa.',
    'Antes de registrar informações, leia `.brain/CURRENT_SESSION.md` no vault.',
    'Nunca sobrescreva o histórico anterior. Registre cada iteração como `### HH:MM - Título` DENTRO da seção `## Iterações` (logo antes de `## Decisões geradas nesta sessão`). Cada iteração deve trazer contexto conversado suficiente: pedido do usuário, investigação/ações, evidências relevantes e estado final. NUNCA escreva iterações após `## Encerramento`.',
    '',
    ...VAULT_COMPLEMENT_RULES,
    'Não registre chaves, tokens, senhas ou segredos; substitua por `[REDACTED_SECRET]`.',
    `Wikilink da sessão: ${wikilinkFromRel(relPath)}`,
    '</obsidian_session>',
  ].join('\n');
}

function updateSessionFrontmatter(content) {
  let next = content;
  next = next.replace(/^status:.*$/m, 'status: active');
  next = next.replace(/^ended_at:.*$/m, 'ended_at:');
  return next;
}

function upsertSummaryFrontmatter(content, summary) {
  if (/^summary:/m.test(content)) return content.replace(/^summary:.*$/m, `summary: ${yamlQuote(summary)}`);
  return content.replace(/^status:.*$/m, (line) => `${line}\nsummary: ${yamlQuote(summary)}`);
}

function updateSessionDescription(content, { relPath, summary, startedAt }) {
  const startedDate = startedAt ? new Date(startedAt) : new Date();
  const titleTime = Number.isFinite(startedDate.getTime()) ? formatTime(startedDate).slice(0, 5) : '';
  let next = upsertSummaryFrontmatter(content, summary);
  if (titleTime) {
    next = next.replace(/^# .+$/m, `# ${titleTime} - ${summary}`);
  }
  next = next.replace(/- \*\*Arquivo:\*\* `[^`]+`/m, `- **Arquivo:** \`${relPath}\``);
  next = next.replace(
    /(## Objetivo da sessão\n\n)>[^\n]*/m,
    `$1> ${summary === 'session' ? 'Preencher durante a sessão.' : summary}`,
  );
  return next;
}

function maybeRetitleSession({ vaultBase, relPath, startedAt, input }) {
  const summary = sessionSummaryFromInput(input);
  if (!isUsableSummary(summary)) return { relPath, summary, changed: false };

  const currentPath = join(vaultBase, relPath);
  if (!existsSync(currentPath)) return { relPath, summary, changed: false };

  let nextRelPath = relPath;
  if (isPlaceholderSessionFile(relPath)) {
    const startedDate = startedAt ? new Date(startedAt) : new Date();
    const baseDate = Number.isFinite(startedDate.getTime()) ? startedDate : new Date();
    const nextPath = uniquePath(join(dirname(currentPath), sessionFileName(baseDate, summary)));
    if (nextPath !== currentPath) {
      renameSync(currentPath, nextPath);
      nextRelPath = toVaultRelative(vaultBase, nextPath);
    }
  }

  const sessionPath = join(vaultBase, nextRelPath);
  const content = readFileSync(sessionPath, 'utf-8');
  const updated = updateSessionDescription(content, { relPath: nextRelPath, summary, startedAt });
  if (updated !== content) writeFileSync(sessionPath, updated, 'utf-8');

  return { relPath: nextRelPath, summary, changed: nextRelPath !== relPath || updated !== content };
}

function stripClosingSection(content) {
  const marker = '\n## Encerramento';
  const index = content.indexOf(marker);
  if (index === -1) return content;
  return `${content.slice(0, index).trimEnd()}\n`;
}

function reopenSessionFile(sessionPath) {
  const content = readFileSync(sessionPath, 'utf-8');
  const reopened = stripClosingSection(updateSessionFrontmatter(content));
  writeFileSync(sessionPath, reopened, 'utf-8');
}

function findSessionForInput(vaultBase, input, control) {
  const sessionId = sessionIdFromInput(input);
  const registry = readSessionRegistry(vaultBase);
  const registered = sessionId ? registry.sessions[sessionId] : null;

  if (registered?.session_file) {
    return {
      sessionId,
      relPath: registered.session_file,
      startedAt: registered.started_at || control.started_at || '',
      fromRegistry: true,
    };
  }

  if (sessionId && control.session_id === sessionId && control.last_session_file) {
    return {
      sessionId,
      relPath: control.last_session_file,
      startedAt: control.started_at || '',
      fromRegistry: false,
    };
  }

  return { sessionId, relPath: '', startedAt: '', fromRegistry: false };
}

function activateExistingSession({ vaultBase, relPath, startedAt, sessionId, input, now }) {
  const sessionPath = join(vaultBase, relPath);
  if (!existsSync(sessionPath)) return false;

  reopenSessionFile(sessionPath);
  const nextStartedAt = startedAt || formatLocalIso(now);
  writeControl(vaultBase, {
    status: 'active',
    session_file: relPath,
    last_session_file: relPath,
    started_at: nextStartedAt,
    ended_at: '',
    session_id: sessionId,
    last_logged_turn_id: '',
  });
  upsertSessionRegistry(vaultBase, sessionId, {
    session_file: relPath,
    status: 'active',
    started_at: nextStartedAt,
    ended_at: '',
    transcript_path: input.transcript_path || input.transcriptPath || '',
  });
  return true;
}

function createSession({ vaultBase, sessionId, input, now }) {
  const summary = sessionSummaryFromInput(input);
  const { absPath, relPath } = allocateSessionPath(vaultBase, now, summary);
  const startedAt = formatLocalIso(now);
  writeFileSync(absPath, buildSessionContent({ relPath, now, summary }), 'utf-8');
  writeControl(vaultBase, {
    status: 'active',
    session_file: relPath,
    last_session_file: relPath,
    started_at: startedAt,
    ended_at: '',
    session_id: sessionId,
    last_logged_turn_id: '',
  });
  upsertSessionRegistry(vaultBase, sessionId, {
    session_file: relPath,
    status: 'active',
    started_at: startedAt,
    ended_at: '',
    transcript_path: input.transcript_path || input.transcriptPath || '',
  });
  return { relPath, startedAt };
}

function outputActiveContext({ relPath, startedAt, vaultBase, message }) {
  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: buildAdditionalContext({ relPath, startedAt, vaultBase }),
    },
    systemMessage: message,
  });
}

function main() {
  const input = readHookInput();
  const vaultBase = getVaultBase(input);
  warnIfDefaultVault(input);
  const now = new Date();
  const sessionId = sessionIdFromInput(input);

  // Fast path: skip all writes if control file touched < 5 min ago and session matches
  try {
    const ctrlPath = controlPath(vaultBase);
    const { mtimeMs } = statSync(ctrlPath);
    if ((now.getTime() - mtimeMs) / 1000 < 300) {
      const ctrl = readControl(vaultBase);
      if (
        ctrl.status === 'active' &&
        ctrl.session_file &&
        !isPlaceholderSessionFile(ctrl.session_file) &&
        existsSync(join(vaultBase, ctrl.session_file)) &&
        (!sessionId || ctrl.session_id === sessionId)
      ) {
        writeHookOutput({});
        return;
      }
    }
  } catch (err) {
    debugLog('session-ensure fast-path skipped:', err);
  }

  const control = readControl(vaultBase);

  if (control.status === 'active' && control.session_file) {
    const activePath = join(vaultBase, control.session_file);
    // Sem reuso-por-janela: só reaproveita a nota do control quando não há
    // identidade pra checar (!sessionId) ou quando é a MESMA conversa. Conversa
    // concorrente recente NÃO pode herdar a nota ativa do ponteiro global.
    if (existsSync(activePath) && (!sessionId || control.session_id === sessionId)) {
      const titled = maybeRetitleSession({
        vaultBase,
        relPath: control.session_file,
        startedAt: control.started_at,
        input,
      });
      const activeRelPath = titled.relPath;
      if (titled.changed || control.session_file !== activeRelPath || control.session_id !== sessionId) {
        writeControl(vaultBase, {
          status: 'active',
          session_file: activeRelPath,
          last_session_file: activeRelPath,
          started_at: control.started_at,
          ended_at: '',
          session_id: sessionId || control.session_id,
          last_logged_turn_id: control.last_logged_turn_id || '',
        });
      }
      upsertSessionRegistry(vaultBase, sessionId || control.session_id, {
        session_file: activeRelPath,
        status: 'active',
        started_at: control.started_at,
        ended_at: '',
        transcript_path: input.transcript_path || input.transcriptPath || '',
      });
      writeHookOutput({});
      return;
    }
  }

  const target = findSessionForInput(vaultBase, input, control);
  if (target.relPath && activateExistingSession({ vaultBase, relPath: target.relPath, startedAt: target.startedAt, sessionId: target.sessionId, input, now })) {
    outputActiveContext({
      relPath: target.relPath,
      startedAt: target.startedAt || formatLocalIso(now),
      vaultBase,
      message: `Sessão Obsidian reaberta em ${target.relPath}. ${basename(controlPath(vaultBase))} atualizado.`,
    });
    return;
  }

  const created = createSession({ vaultBase, sessionId, input, now });
  outputActiveContext({
    relPath: created.relPath,
    startedAt: created.startedAt,
    vaultBase,
    message: `Sessão Obsidian criada em ${created.relPath}. ${basename(controlPath(vaultBase))} atualizado.`,
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`[codex-obsidian] UserPromptSubmit falhou: ${error.message}\n`);
  writeHookOutput({});
}
