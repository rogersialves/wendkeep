#!/usr/bin/env node
import { existsSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import {
  controlPath,
  ensureDir,
  findActiveSessionByTranscript,
  formatDate,
  formatHourMinute,
  formatLocalIso,
  formatTime,
  getVaultBase,
  warnIfDefaultVault,
  providerMeta,
  readControl,
  readHookInput,
  readSessionRegistry,
  sessionFileName,
  sessionFolderRel,
  sessionSummaryFromInput,
  shouldReuseActiveSession,
  sweepStaleSessionsFile,
  toVaultRelative,
  uniquePath,
  upsertSessionRegistry,
  VAULT_COMPLEMENT_RULES,
  wikilinkFromRel,
  writeControl,
  writeHookOutput,
  yamlQuote,
} from './obsidian-common.mjs';

function buildSessionContent({ relPath, now, summary = 'session' }) {
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

Sessão iniciada automaticamente pelo hook de início (${provider.label}).

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

- [ ] Revisar resumo da sessão
- [ ] Verificar se houve decisões a registrar
- [ ] Verificar se houve bugs a registrar
- [ ] Verificar se houve aprendizados a registrar

## Encerramento

Sessão ainda em andamento.
`;
}

function allocateSessionPath(vaultBase, now, summary = 'session') {
  const folderRel = sessionFolderRel(now, vaultBase);
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

function main() {
  const input = readHookInput();
  const vaultBase = getVaultBase(input);
  warnIfDefaultVault(input);
  const now = new Date();
  const sessionId = input.session_id || input.sessionId || '';
  const control = readControl(vaultBase);

  // Fecha sessões `active` órfãs (sem evento de fim — janela fechada/crash) antes
  // de seguir. Preserva a deste transcript: pode ser reaproveitada logo abaixo.
  try {
    sweepStaleSessionsFile(vaultBase, now, undefined, input.transcript_path || input.transcriptPath || '');
  } catch (error) {
    process.stderr.write(`[codex-obsidian] sweep de sessões falhou: ${error.message}\n`);
  }

  // Reuso da nota apontada pelo CURRENT_SESSION só quando é a MESMA conversa
  // (session_id idêntico). NÃO reusar por janela de tempo: o ponteiro global é
  // racy e uma conversa concorrente recente faria esta adotar a nota da outra.
  // Resume/compactação (session_id novo, mesmo transcript) é tratado abaixo por
  // identidade de transcript (findActiveSessionByTranscript).
  if (control.status === 'active' && control.session_file && control.session_id === sessionId) {
    const activePath = join(vaultBase, control.session_file);
    if (existsSync(activePath)) {
      upsertSessionRegistry(vaultBase, sessionId, {
        session_file: control.session_file,
        status: 'active',
        started_at: control.started_at,
        ended_at: '',
      });
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildAdditionalContext({
            relPath: control.session_file,
            startedAt: control.started_at,
            vaultBase,
          }),
        },
      });
      return;
    }
  }

  // Reuso DETERMINISTICO por session_id: o id e estavel em todo o ciclo da conversa
  // (inclusive resume/compactacao apos a janela de 10min e virada de dia). O ponteiro
  // CURRENT_SESSION e racy — sessoes Codex intercaladas o clobberam — entao olhamos o
  // registry direto pelo session_id antes de criar nota nova. Previne o split (mesma
  // sessao em duas notas). Recria o esqueleto no MESMO caminho se a nota sumiu.
  if (sessionId) {
    const known = readSessionRegistry(vaultBase).sessions?.[sessionId];
    if (known && known.status === 'active' && known.session_file) {
      const knownAbs = join(vaultBase, known.session_file);
      if (!existsSync(knownAbs)) {
        ensureDir(join(vaultBase, known.session_file.split('/').slice(0, -1).join('/')));
        writeFileSync(knownAbs, buildSessionContent({ relPath: known.session_file, now, summary: sessionSummaryFromInput(input) }), 'utf-8');
      }
      const startedAt = known.started_at || control.started_at || formatLocalIso(now);
      writeControl(vaultBase, {
        status: 'active',
        session_file: known.session_file,
        last_session_file: known.session_file,
        started_at: startedAt,
        ended_at: '',
        session_id: sessionId,
        last_logged_turn_id: control.last_logged_turn_id || '',
      });
      upsertSessionRegistry(vaultBase, sessionId, {
        session_file: known.session_file,
        status: 'active',
        started_at: startedAt,
        ended_at: '',
        transcript_path: input.transcript_path || input.transcriptPath || known.transcript_path || '',
      });
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildAdditionalContext({ relPath: known.session_file, startedAt, vaultBase }),
        },
      });
      return;
    }
  }

  // Re-init da conversa (compactação/resume) traz um session_id novo e cai fora
  // da janela de reuso; o transcript continua o mesmo. Reaproveita a sessão ativa
  // desse transcript em vez de criar um placeholder `HH-MM-codex`.
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  if (transcriptPath) {
    const match = findActiveSessionByTranscript(vaultBase, transcriptPath);
    if (match) {
      // fail-safe: a nota do registro pode ter sumido do disco (git stash/checkout/
      // sync removeram o arquivo). Em vez de mintar uma nota nova (split de sessão),
      // recria o esqueleto no MESMO caminho e segue reaproveitando.
      const matchAbs = join(vaultBase, match.session_file);
      if (!existsSync(matchAbs)) {
        ensureDir(join(vaultBase, match.session_file.split('/').slice(0, -1).join('/')));
        writeFileSync(matchAbs, buildSessionContent({ relPath: match.session_file, now, summary: sessionSummaryFromInput(input) }), 'utf-8');
      }
      const startedAt = match.started_at || control.started_at || formatLocalIso(now);
      writeControl(vaultBase, {
        status: 'active',
        session_file: match.session_file,
        last_session_file: match.session_file,
        started_at: startedAt,
        ended_at: '',
        session_id: sessionId || match.sessionId,
        last_logged_turn_id: control.last_logged_turn_id || '',
      });
      upsertSessionRegistry(vaultBase, sessionId || match.sessionId, {
        session_file: match.session_file,
        status: 'active',
        started_at: startedAt,
        ended_at: '',
        transcript_path: transcriptPath,
      });
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: buildAdditionalContext({ relPath: match.session_file, startedAt, vaultBase }),
        },
      });
      return;
    }
  }

  const summary = sessionSummaryFromInput(input);
  const { absPath, relPath } = allocateSessionPath(vaultBase, now, summary);
  const startedAt = formatLocalIso(now);
  writeFileSync(absPath, buildSessionContent({ relPath, now, summary }), 'utf-8');
  writeControl(vaultBase, {
    status: 'active',
    session_file: relPath,
    last_session_file: relPath,
    started_at: startedAt,
    session_id: sessionId,
  });
  upsertSessionRegistry(vaultBase, sessionId, {
    session_file: relPath,
    status: 'active',
    started_at: startedAt,
    ended_at: '',
  });

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildAdditionalContext({ relPath, startedAt, vaultBase }),
    },
    systemMessage: [
      `Sessão ${providerMeta().label} criada em ${relPath}.`,
      `${basename(controlPath(vaultBase))} atualizado.`,
      'Iterações devem ser anexadas, nunca sobrescritas.',
    ].join(' '),
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`[codex-obsidian] SessionStart falhou: ${error.message}\n`);
  writeHookOutput({
    systemMessage: `[codex-obsidian] Não foi possível criar a sessão Obsidian: ${error.message}`,
  });
}
