#!/usr/bin/env node
// PreToolUse guard. R1 protects the explicit archive --force decision. The project-scope
// policy protects mutable Git/filesystem tools before they run, including Codex's raw-string
// and object-shaped tool_input variants. Host adapters never emit `ask` for Codex: the Codex
// contract accepts `deny` in PreToolUse, while Claude may still use `ask` for its own approval UI.
import { pathToFileURL } from 'node:url';
import { readHookInput, readSessionRegistry, writeHookOutput } from './obsidian-common.mjs';
import { activeChange, quickGateState } from './change-core.mjs';
import { hookProfilePolicy, resolveHookOperatingProfile } from './operating-profile-runtime.mjs';
import { isProjectVaultIntegrityError } from '../src/project-vault.mjs';
import {
  captureProjectScope,
  commandHasUnprovenTarget,
  extractToolCommand,
  scopeDecision,
  scopeForRegistry,
} from './project-scope.mjs';

function bindingFailureDecision(diagnostic) {
  const code = diagnostic?.code || 'WENDKEEP_VAULT_CONFIG_INVALID';
  const raw = diagnostic?.message || String(diagnostic || 'Configuração WendKeep inválida.');
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 420);
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `${code}: ${detail} Corrija o binding antes de executar uma ação mutável.`,
  };
}

function hostFor({ host, provider } = {}) {
  if (host) return host;
  if (provider === 'codex') return 'codex';
  // Pure callers historically represented Claude's approval UI without a provider field.
  return 'claude';
}

function scopeGuardDecision(command, {
  input = {},
  host,
  provider,
  expectedScope,
  actualScope,
  activeSessions = [],
  projectRoot = '',
  projectId = '',
  sessionId = '',
} = {}) {
  if (!expectedScope && input?.project_scope) expectedScope = input.project_scope;
  if (!expectedScope && input?.projectScope) expectedScope = input.projectScope;
  const actual = actualScope || captureProjectScope({
    input,
    projectRoot,
    projectId,
    provider,
    sessionId,
  });
  const commandTargetKnown = !commandHasUnprovenTarget(command);
  return scopeDecision({
    command,
    input,
    expectedScope,
    actualScope: actual,
    host: hostFor({ host, provider }),
    commandTargetKnown,
    activeSessions,
    currentSessionId: sessionId,
  });
}

export function guardDecision(command, {
  vaultBase,
  env = process.env,
  profile = 'GOVERN',
  input = {},
  host,
  provider,
  expectedScope,
  actualScope,
  projectRoot = '',
  projectId = '',
  sessionId = '',
} = {}) {
  if (!hookProfilePolicy(profile).harness) return null;
  const cmd = String(command || '');

  // R1: archive --force — parser/policy only, no scope is needed to deny the bypass.
  if (/\b(?:wendkeep|wk)\b.*\bchange\s+archive\b.*--force(?:=|\b)/i.test(cmd)
    || /(?:wendkeep\.mjs|wendkeep\.cmd)\s+change\s+archive\b.*--force(?:=|\b)/i.test(cmd)) {
    if (env.WENDKEEP_ALLOW_FORCE !== '1') {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: '`change archive --force` é decisão do usuário, não sua. Gate vermelho = trabalho pendente: rode `wendkeep change status` e conclua as tarefas, ou `wendkeep change abandon <slug>` se a change não vai adiante. Se o usuário pediu o force explicitamente, peça a ele para rodar com WENDKEEP_ALLOW_FORCE=1.',
      };
    }
  }

  const scoped = scopeGuardDecision(cmd, {
    input,
    host,
    provider,
    expectedScope,
    actualScope,
    projectRoot,
    projectId,
    sessionId,
  });
  if (scoped) return scoped;

  // R2: commit with an active change and a bypass/red sensor. This branch is reached only
  // after the project scope is proven. Codex gets deny because PreToolUse cannot ask.
  if (/\bgit(?:\.exe|\.cmd)?\b[^;&|\n]*\bcommit\b/i.test(cmd)) {
    const slug = activeChange(vaultBase);
    if (!slug) return null;
    const noVerify = /(?:^|\s)--no-verify(?:=|\s|$)/i.test(cmd);
    const gate = noVerify ? null : quickGateState(vaultBase);
    if (noVerify || (gate && gate.redCritical)) {
      const selectedHost = hostFor({ host, provider });
      const reason = noVerify
        ? `git commit --no-verify com a change "${slug}" ativa — commitar pulando os hooks?`
        : `A change ativa "${slug}" tem sensor crítico vermelho (wendkeep verify falhou). Commitar mesmo assim?`;
      return {
        permissionDecision: selectedHost === 'codex' ? 'deny' : 'ask',
        permissionDecisionReason: selectedHost === 'codex'
          ? `${reason} O Codex exige uma autorização explícita fora do PreToolUse; execute a ação conscientemente após corrigir o gate.`
          : reason,
      };
    }
  }
  return null;
}

function runtimeScope(runtime, input) {
  const identity = runtime.identity || {};
  const sessionId = identity.canonicalConversationId || input.session_id || input.sessionId || '';
  const expected = runtime.entry?.project_scope
    ? {
      ...runtime.entry.project_scope,
      conflict: runtime.entry.project_scope_conflict === true,
    }
    : null;
  const actual = captureProjectScope({
    input,
    projectRoot: runtime.projectRoot || runtime.resolution?.projectRoot || '',
    projectId: runtime.resolution?.projectId || '',
    provider: identity.provider || 'codex',
    sessionId,
  });
  const registry = readSessionRegistry(runtime.vaultBase);
  const activeSessions = Object.entries(registry.sessions || {})
    .filter(([, entry]) => entry?.status === 'active');
  return { expectedScope: expected, actualScope: actual, activeSessions, sessionId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({ input });
    const command = extractToolCommand(input);
    const scope = runtime.bindingError ? null : runtimeScope(runtime, input);
    const d = runtime.bindingError
      ? bindingFailureDecision(runtime.bindingError)
      : guardDecision(command, {
        vaultBase: runtime.vaultBase,
        profile: runtime.profile,
        input,
        provider: runtime.identity?.provider,
        host: runtime.identity?.provider,
        expectedScope: scope.expectedScope,
        actualScope: scope.actualScope,
        activeSessions: scope.activeSessions,
        projectRoot: runtime.projectRoot,
        projectId: runtime.resolution?.projectId,
        sessionId: scope.sessionId,
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
      // A malformed hook envelope cannot prove the target. Return a visible deny rather than
      // silently permitting a mutable tool with unknown project scope.
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          ...bindingFailureDecision({ code: 'WENDKEEP_SCOPE_INPUT_INVALID', message: error.message }),
        },
      });
    }
  }
}

export { scopeForRegistry };
