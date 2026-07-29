import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { detectProvider, readSessionRegistry } from './obsidian-common.mjs';
import {
  inspectTranscriptIdentityContent,
  resolveSessionIdentitySnapshot,
} from '../packages/integrations/src/session-identity.mjs';

export function inspectTranscriptIdentity(transcriptPath) {
  const content = transcriptPath && existsSync(transcriptPath)
    ? readFileSync(transcriptPath, 'utf-8')
    : '';
  return inspectTranscriptIdentityContent(content, {
    fallbackTranscriptId: transcriptPath ? basename(transcriptPath, '.jsonl') : '',
  });
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
  return {
    identity,
    entry: readSessionRegistry(vaultBase).sessions?.[identity.canonicalConversationId] || null,
  };
}
