function parseJsonLines(content = '') {
  return String(content || '').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function inspectTranscriptIdentityContent(content, { fallbackTranscriptId = '' } = {}) {
  const lines = parseJsonLines(content);
  const codexMeta = lines.find((event) => event.type === 'session_meta')?.payload;
  if (codexMeta) {
    return {
      transcriptProvider: 'openai',
      provider: 'codex',
      canonicalConversationId: codexMeta.session_id || codexMeta.id || '',
      transcriptId: codexMeta.id || fallbackTranscriptId,
      parentConversationId: codexMeta.parent_thread_id || codexMeta.forked_from_id || '',
    };
  }
  const claudeEvent = lines.find((event) => event.sessionId);
  if (claudeEvent) {
    return {
      transcriptProvider: 'anthropic',
      provider: 'claude',
      canonicalConversationId: claudeEvent.sessionId,
      transcriptId: fallbackTranscriptId,
      parentConversationId: '',
    };
  }
  return {
    transcriptProvider: 'unknown',
    provider: 'unknown',
    canonicalConversationId: '',
    transcriptId: '',
    parentConversationId: '',
  };
}

function compatible(provider, transcriptProvider) {
  return (provider === 'codex' && transcriptProvider === 'openai')
    || (provider === 'claude' && transcriptProvider === 'anthropic');
}

function canonicalUuid(value = '') {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : '';
}

function pathBasename(path = '') {
  const normalized = String(path || '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.jsonl$/i, '');
}

function providerMatches(entry, provider) {
  return entry?.provider === provider;
}

export function transcriptsMatch(a, b) {
  if (!a || !b) return false;
  const normalize = (path) => String(path || '').replace(/\\/g, '/').toLowerCase();
  const normalizedA = normalize(a);
  const normalizedB = normalize(b);
  if (normalizedA === normalizedB) return true;
  const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
  const basenameA = basename(normalizedA);
  return Boolean(basenameA) && basenameA === basename(normalizedB);
}

export function resolveSessionIdentitySnapshot({
  input = {},
  provider = 'codex',
  codexThreadId = '',
  transcriptPath = '',
  inspected = {},
  registry = { version: 2, sessions: {} },
} = {}) {
  const explicitTranscriptPath = String(transcriptPath || '');
  const hookId = input.session_id || input.sessionId || '';
  const threadId = canonicalUuid(
    input.codex_thread_id || input.codexThreadId || codexThreadId || '',
  );
  const transcriptConversationId = canonicalUuid(inspected.canonicalConversationId);

  if (provider === 'codex' && transcriptConversationId && threadId
    && transcriptConversationId !== threadId) {
    return {
      state: 'deferred',
      provider,
      transcriptPath: explicitTranscriptPath,
      diagnostics: [`CODEX_THREAD_ID diverge do session_id do transcript (${threadId} != ${transcriptConversationId})`],
    };
  }

  if (provider === 'codex' && !inspected.canonicalConversationId && threadId) {
    return {
      state: 'resolved',
      provider,
      canonicalConversationId: threadId,
      hookSessionId: hookId,
      transcriptPath: explicitTranscriptPath,
      transcriptId: explicitTranscriptPath ? pathBasename(explicitTranscriptPath) : threadId,
      parentConversationId: '',
      diagnostics: [],
    };
  }

  if (provider === 'claude' && hookId && !inspected.canonicalConversationId) {
    return {
      state: 'resolved',
      provider,
      canonicalConversationId: hookId,
      hookSessionId: hookId,
      transcriptPath: explicitTranscriptPath,
      transcriptId: explicitTranscriptPath ? pathBasename(explicitTranscriptPath) : hookId,
      parentConversationId: '',
      diagnostics: [],
    };
  }

  if (!explicitTranscriptPath && hookId) {
    const entry = registry?.sessions?.[hookId];
    if (entry?.transcript_path && providerMatches(entry, provider)) {
      return {
        state: 'resolved',
        provider,
        canonicalConversationId: hookId,
        hookSessionId: hookId,
        transcriptPath: entry.transcript_path,
        transcriptId: entry.transcript_id || pathBasename(entry.transcript_path),
        parentConversationId: '',
        diagnostics: ['transcript recuperado do SESSION_REGISTRY'],
      };
    }
  }

  if (!explicitTranscriptPath || !inspected.canonicalConversationId) {
    return {
      state: 'deferred',
      provider,
      transcriptPath: explicitTranscriptPath,
      diagnostics: ['transcript ausente ou sem identidade canônica'],
    };
  }
  if (!compatible(provider, inspected.transcriptProvider)) {
    return {
      state: 'deferred',
      provider,
      transcriptPath: explicitTranscriptPath,
      diagnostics: [`provider ${provider} incompatível com transcript ${inspected.transcriptProvider}`],
    };
  }

  const byTranscript = Object.entries(registry?.sessions || {}).find(([, entry]) => {
    if (!providerMatches(entry, provider)) return false;
    const paths = [
      ...(Array.isArray(entry?.transcript_paths) ? entry.transcript_paths : []),
      entry?.transcript_path,
    ].filter(Boolean);
    return paths.some((path) => transcriptsMatch(path, explicitTranscriptPath));
  });

  return {
    state: 'resolved',
    provider,
    canonicalConversationId: byTranscript?.[0] || inspected.canonicalConversationId,
    hookSessionId: hookId,
    transcriptPath: explicitTranscriptPath,
    transcriptId: inspected.transcriptId,
    parentConversationId: inspected.parentConversationId,
    diagnostics: [],
  };
}
