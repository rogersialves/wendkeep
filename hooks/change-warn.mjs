#!/usr/bin/env node
// PostToolUse hook (matcher: Edit|Write|MultiEdit). Quando o agente edita CÓDIGO sem change
// ativa, avisa UMA vez por sessão que trabalho não-trivial deve rotear pelo loop a2. Nunca
// bloqueia — mudança trivial pode seguir. Ignora edições no vault e em .claude/.agent/.brain.
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { profileRuntimeError } from './brain-inject.mjs';
import { activeChange, readSentinel, writeSentinel } from './change-core.mjs';
import {
  hookProfilePolicy,
  profileSentinelId,
  resolveHookOperatingProfile,
} from './operating-profile-runtime.mjs';

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|prisma|sql|go|rs|java|cs)$/i;

export function isCodeFile(p) {
  return CODE_EXT.test(String(p || '').replace(/\\/g, '/'));
}

const norm = (p) => String(p || '').replace(/\\/g, '/');

// Retorna o additionalContext do aviso, ou null (caso comum).
export function warnDecision(filePath, {
  vaultBase,
  cwd = '.',
  sessionId = '',
  profile = 'GOVERN',
} = {}) {
  const policy = hookProfilePolicy(profile);
  if (!policy.requiresChange) return null;
  if (!filePath || !isCodeFile(filePath)) return null;
  if (activeChange(vaultBase)) return null;
  const abs = norm(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  // Dentro do vault (NTFS é case-insensitive) ou em dirs de config de agente: não é código do projeto.
  if (abs.toLowerCase().startsWith(`${norm(resolve(vaultBase)).toLowerCase()}/`)) return null;
  if (/\/(\.claude|\.agent|\.brain)\//.test(`${abs}/`)) return null;
  const sentinelId = profileSentinelId(sessionId, profile);
  if (readSentinel(vaultBase, 'warn', sentinelId)) return null;
  writeSentinel(vaultBase, 'warn', sentinelId);
  return [
    '<change_warn>',
    `Você editou código (${filePath}) sem change ativa. Para trabalho não-trivial, roteie pelo processo: \`wendkeep change new <slug>\` e preencha proposta/design/tarefas (skill wk-workflow). Ignore se for um ajuste trivial — este aviso não repete nesta sessão.`,
    '</change_warn>',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({ input });
    const warn = runtime.bindingError
      ? profileRuntimeError(runtime.bindingError)
      : warnDecision(input.tool_input?.file_path, {
        vaultBase: runtime.vaultBase,
        cwd: input.cwd || '.',
        sessionId: input.session_id || input.sessionId || '',
        profile: runtime.profile,
      });
    if (!warn) { writeHookOutput({}); }
    else writeHookOutput({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: warn } });
  } catch {
    writeHookOutput({});
  }
}
