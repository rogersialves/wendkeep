#!/usr/bin/env node
// PreToolUse hook (matcher: Bash). O gate mecânico do loop a2 no ponto de execução:
//   R1 — `wendkeep|wk change archive --force` vindo do AGENTE é negado (deny). Gate vermelho
//        significa trabalho pendente; --force é decisão do usuário (escape: WENDKEEP_ALLOW_FORCE=1
//        no ambiente do processo — env inline no texto do comando NÃO conta).
//   R2 — `git commit` com change ativa E (--no-verify OU sensor crítico vermelho) vira `ask`
//        (o usuário decide com 1 clique; falso-positivo custa pouco).
// Fast-path: comando sem wendkeep/wk/git sai sem NENHUM I/O. Ausência normal continua
// fail-open; corrupção do binding é diagnóstico visível e fail-closed.
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { activeChange, quickGateState } from './change-core.mjs';
import { hookProfilePolicy, resolveHookOperatingProfile } from './operating-profile-runtime.mjs';
import { isProjectVaultIntegrityError } from '../src/project-vault.mjs';

const WK_EXECUTABLES = new Set([
  'wendkeep', 'wendkeep.cmd', 'wendkeep.exe', 'wendkeep.ps1', 'wendkeep.mjs',
  'wk', 'wk.cmd', 'wk.exe', 'wk.ps1',
]);
const NODE_EXECUTABLES = new Set(['node', 'node.exe']);
const NPX_EXECUTABLES = new Set(['npx', 'npx.cmd', 'npx.exe']);
const GIT_EXECUTABLES = new Set(['git', 'git.exe', 'git.cmd']);

function shellSegments(command) {
  const tokens = String(command || '').match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|&&|\|\||[;|\n]|&|[^\s;&|]+/g) || [];
  const segments = [];
  let current = [];
  const flush = () => {
    if (current.length) segments.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n'].includes(token) || (token === '&' && current.length)) {
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return segments;
}

function unquote(token) {
  const value = String(token || '');
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"')
    || (value[0] === "'" && value.at(-1) === "'"))) return value.slice(1, -1);
  return value;
}

function executableName(token) {
  return unquote(token).replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

function invocationOf(segment) {
  let index = 0;
  while (segment[index] === '&' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] || '')) index += 1;
  const executable = executableName(segment[index]);
  if (WK_EXECUTABLES.has(executable)) {
    return { kind: 'wendkeep', args: segment.slice(index + 1).map(unquote) };
  }
  if (NODE_EXECUTABLES.has(executable)) {
    let scriptIndex = index + 1;
    while (String(segment[scriptIndex] || '').startsWith('-')) scriptIndex += 1;
    if (executableName(segment[scriptIndex]) === 'wendkeep.mjs') {
      return { kind: 'wendkeep', args: segment.slice(scriptIndex + 1).map(unquote) };
    }
  }
  if (NPX_EXECUTABLES.has(executable)) {
    let packageIndex = index + 1;
    while (String(segment[packageIndex] || '').startsWith('-')) packageIndex += 1;
    if (WK_EXECUTABLES.has(executableName(segment[packageIndex]))) {
      return { kind: 'wendkeep', args: segment.slice(packageIndex + 1).map(unquote) };
    }
  }
  if (GIT_EXECUTABLES.has(executable)) {
    return { kind: 'git', args: segment.slice(index + 1).map(unquote) };
  }
  return null;
}

function commandInvocations(command) {
  return shellSegments(command).map(invocationOf).filter(Boolean);
}

function bindingFailureDecision(diagnostic) {
  const code = diagnostic?.code || 'WENDKEEP_VAULT_CONFIG_INVALID';
  const raw = diagnostic?.message || String(diagnostic || 'Configuração WendKeep inválida.');
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 420);
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `${code}: ${detail} Corrija o binding antes de executar uma ação mutável.`,
  };
}

export function guardDecision(command, { vaultBase, env = process.env, profile = 'GOVERN' } = {}) {
  if (!hookProfilePolicy(profile).harness) return null;
  const cmd = String(command || '');
  const invocations = commandInvocations(cmd);
  if (!invocations.length) return null; // fast-path: parsing puro, zero I/O para o caso comum

  // R1: archive --force — parser puro, ainda sem I/O. Reason fala com o AGENTE (deny).
  const forcedArchive = invocations.find(({ kind, args }) => kind === 'wendkeep'
    && args[0]?.toLowerCase() === 'change'
    && args[1]?.toLowerCase() === 'archive'
    && args.some((arg) => /^--force(?:=|$)/i.test(arg)));
  if (forcedArchive) {
    if (env.WENDKEEP_ALLOW_FORCE === '1') return null;
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: '`change archive --force` é decisão do usuário, não sua. Gate vermelho = trabalho pendente: rode `wendkeep change status` e conclua as tarefas, ou `wendkeep change abandon <slug>` se a change não vai adiante. Se o usuário pediu o force explicitamente, peça a ele para rodar com WENDKEEP_ALLOW_FORCE=1.',
    };
  }

  // R2: git commit — 1ª leitura de fs só acontece aqui. Reason fala com o USUÁRIO (ask).
  const gitCommit = invocations.find(({ kind, args }) => kind === 'git'
    && args.some((arg) => arg.toLowerCase() === 'commit'));
  if (gitCommit) {
    const slug = activeChange(vaultBase);
    if (!slug) return null;
    const noVerify = gitCommit.args.some((arg) => /^--no-verify(?:=|$)/i.test(arg));
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
    const runtime = resolveHookOperatingProfile({ input });
    const d = runtime.bindingError
      ? bindingFailureDecision(runtime.bindingError)
      : guardDecision(input.tool_input?.command, {
        vaultBase: runtime.vaultBase,
        profile: runtime.profile,
      });
    if (d) writeHookOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...d } });
    // allow implícito: exit 0 sem output
  } catch (error) {
    if (isProjectVaultIntegrityError(error)) {
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          ...bindingFailureDecision(error),
        },
      });
    } else {
      writeHookOutput({}); // ausência/erro não-corrupto preserva compatibilidade fail-open
    }
  }
}
