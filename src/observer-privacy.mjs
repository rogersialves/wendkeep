import { basename } from 'node:path';
import { redactObserverText, redactObserverValue } from '../packages/observer/src/redaction.mjs';

const TRANSCRIPT_PATH_KEY = /^(?:transcript_path|agent_transcript_path|transcriptPath|agentTranscriptPath)$/i;
const TRANSCRIPT_PATH_LINE = /^(\s*["']?(?:transcript_path|agent_transcript_path|transcriptPath|agentTranscriptPath)["']?\s*:\s*)(["']?)(.*?)(\2)(\s*,?\s*)$/gmi;

function sourceLabel(value) {
  return basename(String(value || '').replaceAll('\\', '/'));
}

export function sanitizeObserverContent(content) {
  const safePaths = String(content || '').replace(TRANSCRIPT_PATH_LINE, (_line, prefix, quote, value, _closing, suffix) => (
    `${prefix}${quote}${sourceLabel(value)}${quote}${suffix}`
  ));
  return redactObserverText(safePaths);
}

export function sanitizeObserverMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeObserverMetadata);
  if (!value || typeof value !== 'object') return value;
  return redactObserverValue(Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    TRANSCRIPT_PATH_KEY.test(key) ? sourceLabel(item) : sanitizeObserverMetadata(item),
  ])));
}

export { redactObserverText, redactObserverValue };
