import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { detectProvider, readSessionRegistry, transcriptsMatch } from './obsidian-common.mjs';

function parseLines(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function inspectTranscriptIdentity(transcriptPath) {
  const lines = parseLines(transcriptPath);
  const codexMeta = lines.find((event) => event.type === 'session_meta')?.payload;
  if (codexMeta) {
    return {
      transcriptProvider: 'openai',
      provider: 'codex',
      canonicalConversationId: codexMeta.session_id || codexMeta.id || '',
      transcriptId: codexMeta.id || basename(transcriptPath, '.jsonl'),
      parentConversationId: codexMeta.parent_thread_id || codexMeta.forked_from_id || '',
    };
  }
  const claudeEvent = lines.find((event) => event.sessionId);
  if (claudeEvent) {
    return {
      transcriptProvider: 'anthropic',
      provider: 'claude',
      canonicalConversationId: claudeEvent.sessionId,
      transcriptId: basename(transcriptPath, '.jsonl'),
      parentConversationId: '',
    };
  }
  return { transcriptProvider: 'unknown', provider: 'unknown', canonicalConversationId: '', transcriptId: '', parentConversationId: '' };
}

function compatible(provider, transcriptProvider) {
  return (provider === 'codex' && transcriptProvider === 'openai')
    || (provider === 'claude' && transcriptProvider === 'anthropic');
}

function canonicalUuid(value = '') {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : '';
}

export function resolveSessionIdentity(vaultBase, input = {}, provider = detectProvider()) {
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const inspected = inspectTranscriptIdentity(transcriptPath);
  const hookId = input.session_id || input.sessionId || '';
  const codexThreadId = canonicalUuid(input.codex_thread_id || input.codexThreadId || process.env.CODEX_THREAD_ID || '');

  // Codex Desktop exposes the stable canonical conversation through
  // CODEX_THREAD_ID even when SessionStart/UserPromptSubmit omit transcript_path.
  // This is safer than the hook session_id (which may rotate on resume). Once the
  // rollout materializes, require both canonical sources to agree.
  const transcriptConversationId = canonicalUuid(inspected.canonicalConversationId);
  if (provider === 'codex' && transcriptConversationId && codexThreadId
    && transcriptConversationId !== codexThreadId) {
    return {
      state: 'deferred', provider, transcriptPath,
      diagnostics: [`CODEX_THREAD_ID diverge do session_id do transcript (${codexThreadId} != ${transcriptConversationId})`],
    };
  }
  if (provider === 'codex' && !inspected.canonicalConversationId && codexThreadId) {
    return {
      state: 'resolved',
      provider,
      canonicalConversationId: codexThreadId,
      hookSessionId: hookId,
      transcriptPath,
      transcriptId: transcriptPath ? basename(transcriptPath, '.jsonl') : codexThreadId,
      parentConversationId: '',
      diagnostics: [],
    };
  }

  // Claude: input.session_id já é o id canônico e estável da conversa — idêntico
  // ao sessionId que cada linha do transcript grava. Numa sessão nova o arquivo
  // ainda não materializou em disco quando o hook roda, então inspectTranscriptIdentity
  // volta vazio e o gate abaixo adiaria o 1º turno inteiro (SessionStart + 1º prompt
  // sem nota; sessão curta nunca registrada). Não adiar: usar o hookId direto.
  // Codex NÃO entra aqui de propósito — lá o id do hook no resume é efêmero e ≠ do
  // thread canônico, então seguimos exigindo rollout/registry (incidente 2026-07-11,
  // contaminação cross-provider de sessão).
  if (provider === 'claude' && hookId && !inspected.canonicalConversationId) {
    return {
      state: 'resolved',
      provider,
      canonicalConversationId: hookId,
      hookSessionId: hookId,
      transcriptPath,
      transcriptId: transcriptPath ? basename(transcriptPath, '.jsonl') : hookId,
      parentConversationId: '',
      diagnostics: [],
    };
  }

  if (!transcriptPath || !inspected.canonicalConversationId) {
    return { state: 'deferred', provider, transcriptPath, diagnostics: ['transcript ausente ou sem identidade canônica'] };
  }
  if (!compatible(provider, inspected.transcriptProvider)) {
    return { state: 'deferred', provider, transcriptPath, diagnostics: [`provider ${provider} incompatível com transcript ${inspected.transcriptProvider}`] };
  }

  const registry = readSessionRegistry(vaultBase);
  const byTranscript = Object.entries(registry.sessions || {}).find(([, entry]) => {
    const paths = [...(Array.isArray(entry?.transcript_paths) ? entry.transcript_paths : []), entry?.transcript_path].filter(Boolean);
    return paths.some((path) => transcriptsMatch(path, transcriptPath));
  });
  const canonicalConversationId = byTranscript?.[0] || inspected.canonicalConversationId;
  return {
    state: 'resolved',
    provider,
    canonicalConversationId,
    hookSessionId: hookId,
    transcriptPath,
    transcriptId: inspected.transcriptId,
    parentConversationId: inspected.parentConversationId,
    diagnostics: [],
  };
}

export function resolveSessionEntry(vaultBase, input = {}, provider = detectProvider()) {
  const identity = resolveSessionIdentity(vaultBase, input, provider);
  if (identity.state !== 'resolved') return { identity, entry: null };
  return { identity, entry: readSessionRegistry(vaultBase).sessions?.[identity.canonicalConversationId] || null };
}
