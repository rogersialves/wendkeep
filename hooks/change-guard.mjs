#!/usr/bin/env node
// PreToolUse hook (matcher: Bash). O gate mecânico do loop a2 no ponto de execução:
//   R1 — `wendkeep|wk change archive --force` vindo do AGENTE é negado (deny). Gate vermelho
//        significa trabalho pendente; --force é decisão do usuário (escape: WENDKEEP_ALLOW_FORCE=1
//        no ambiente do processo — env inline no texto do comando NÃO conta).
//   R2 — `git commit` com change ativa E (--no-verify OU sensor crítico vermelho) vira `ask`
//        (o usuário decide com 1 clique; falso-positivo custa pouco).
// Fast-path: comando sem wendkeep/wk/git sai sem NENHUM I/O. Fail-open.
import { pathToFileURL } from 'node:url';
import { getVaultBase, readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { activeChange, quickGateState } from './change-core.mjs';

const FORCE_RE = /\b(?:wendkeep|wk)\s+change\s+archive\b[^|&;\n]*--force\b/;
const GIT_SEG_RE = /(^|&&|;|\|)\s*git\b[^|&;]*\bcommit\b/;
const FAST_RE = /\b(?:wendkeep|wk|git)\b/;

export function guardDecision(command, { vaultBase, env = process.env } = {}) {
  const cmd = String(command || '');
  if (!FAST_RE.test(cmd)) return null; // fast-path: zero I/O para o caso comum

  // R1: archive --force — puro regex, ainda sem I/O. Reason fala com o AGENTE (deny).
  if (FORCE_RE.test(cmd)) {
    if (env.WENDKEEP_ALLOW_FORCE === '1') return null;
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: '`change archive --force` é decisão do usuário, não sua. Gate vermelho = trabalho pendente: rode `wendkeep change status` e conclua as tarefas, ou `wendkeep change abandon <slug>` se a change não vai adiante. Se o usuário pediu o force explicitamente, peça a ele para rodar com WENDKEEP_ALLOW_FORCE=1.',
    };
  }

  // R2: git commit — 1ª leitura de fs só acontece aqui. Reason fala com o USUÁRIO (ask).
  const m = cmd.match(GIT_SEG_RE);
  if (m) {
    const slug = activeChange(vaultBase);
    if (!slug) return null;
    const seg = cmd.slice(m.index + m[1].length).split(/&&|;|\|/)[0];
    const noVerify = /\s--no-verify\b/.test(seg);
    const gate = noVerify ? null : quickGateState(vaultBase);
    if (noVerify || (gate && gate.redCritical)) {
      return {
        permissionDecision: 'ask',
        permissionDecisionReason: noVerify
          ? `git commit --no-verify com a change "${slug}" ativa — commitar pulando os hooks?`
          : `A change ativa "${slug}" tem sensor crítico vermelho (wendkeep verify falhou). Commitar mesmo assim?`,
      };
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const d = guardDecision(input.tool_input?.command, { vaultBase: getVaultBase(input) });
    if (d) writeHookOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...d } });
    // allow implícito: exit 0 sem output
  } catch {
    writeHookOutput({}); // fail-open = allow
  }
}
