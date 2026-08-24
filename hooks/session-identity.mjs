import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { detectProvider, readSessionRegistry } from './obsidian-common.mjs';
import {
  inspectTranscriptIdentityContent,
  resolveSessionIdentitySnapshot,
} from '../packages/integrations/src/session-identity.mjs';
import { readCodexRolloutMeta } from './codex-rollout-meta.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';

export function sessionWorkSessionPatch({
  input = {},
  sessionId = '',
  existingWorkSessionId = '',
} = {}) {
  const shared = input.shared || input.handoff?.shared;
  const explicit = input.work_session_id
    || input.workSessionId
    || shared?.work_session_id
    || shared?.workSessionId
    || input.handoff?.work_session_id
    || input.handoff?.workSessionId
    || '';
  const workSessionId = sanitizeMemoryText(
    explicit || existingWorkSessionId || sessionId,
  ).trim();
  return workSessionId ? { work_session_id: workSessionId } : {};
}

function unknownTranscriptIdentity() {
  return {
    transcriptProvider: 'unknown',
    provider: 'unknown',
    canonicalConversationId: '',
    transcriptId: '',
    parentConversationId: '',
  };
}

function inspectCodexMeta(meta, fallbackTranscriptId) {
  return {
    transcriptProvider: 'openai',
    provider: 'codex',
    canonicalConversationId: meta.session_id || meta.id || '',
    transcriptId: meta.id || fallbackTranscriptId,
    parentConversationId: meta.parent_thread_id || meta.forked_from_id || '',
  };
}

function withoutCodexSessionMeta(content) {
  return String(content || '').split('\n').filter((line) => {
    try { return JSON.parse(line)?.type !== 'session_meta'; } catch { return true; }
  }).join('\n');
}

export function inspectTranscriptIdentity(transcriptPath) {
  const fallbackTranscriptId = transcriptPath ? basename(transcriptPath, '.jsonl') : '';
  if (!transcriptPath || !existsSync(transcriptPath)) return unknownTranscriptIdentity();

  const codexMeta = readCodexRolloutMeta(transcriptPath);
  if (codexMeta.ok) return inspectCodexMeta(codexMeta.meta, fallbackTranscriptId);

  // Claude JSONL has no session_meta header. Preserve its existing full-content inspection,
  // but never reinterpret a later/misplaced Codex meta as the file identity.
  let content;
  try { content = readFileSync(transcriptPath, 'utf-8'); } catch { return unknownTranscriptIdentity(); }
  const inspected = inspectTranscriptIdentityContent(withoutCodexSessionMeta(content), {
    fallbackTranscriptId,
  });
  return inspected.provider === 'claude' ? inspected : unknownTranscriptIdentity();
}

export function resolveSessionIdentity(vaultBase, input = {}, provider = detectProvider()) {
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  return resolveSessionIdentitySnapshot({
    input,
    provider,
    codexThreadId: process.env.CODEX_THREAD_ID || '',
    transcriptPath,
    inspected: inspectTranscriptIdentity(transcriptPath),
    registry: readSessionRegistry(vaultBase),
  });
}

export function resolveSessionEntry(vaultBase, input = {}, provider = detectProvider()) {
  const identity = resolveSessionIdentity(vaultBase, input, provider);
  if (identity.state !== 'resolved') return { identity, entry: null };
  const entry = readSessionRegistry(vaultBase).sessions?.[identity.canonicalConversationId] || null;
  const workSessionId = entry?.work_session_id ? String(entry.work_session_id) : '';
  return {
    identity: workSessionId ? { ...identity, work_session_id: workSessionId } : identity,
    entry,
  };
}
