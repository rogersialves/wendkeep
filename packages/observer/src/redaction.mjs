import { basename } from 'node:path';

const SENSITIVE_KEY = /(?:authorization|password|passwd|secret|api[_-]?key|connection[_-]?string|cookie)|^(?:token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token)$/i;
const PATH_KEY = /^(?:transcript_path|agent_transcript_path|transcriptPath|agentTranscriptPath)$/i;
const BUILT_INS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^\s/:@]+):([^\s/@]+)@/gi, (_all, user) => `postgres://${user}:[REDACTED]@`],
  [/\b(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[REDACTED]@'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]'],
  [/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g, '[PHONE]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[ACCESS_KEY]'],
];

function sourceLabel(value) {
  return basename(String(value || '').replaceAll('\\', '/'));
}

function customRules(config = {}) {
  return (Array.isArray(config.rules) ? config.rules : []).flatMap((rule) => {
    try {
      if (!rule?.pattern) return [];
      return [[new RegExp(String(rule.pattern), 'giu'), String(rule.replacement || '[REDACTED]')]];
    } catch {
      return [];
    }
  });
}

export function redactObserverText(value, config = {}) {
  let result = String(value ?? '');
  for (const [pattern, replacement] of [...BUILT_INS, ...customRules(config)]) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactObserverValue(value, config = {}, key = '') {
  if (PATH_KEY.test(key)) return sourceLabel(value);
  if (SENSITIVE_KEY.test(key)) return value ? '[REDACTED]' : value;
  if (typeof value === 'string') return redactObserverText(value, config);
  if (Array.isArray(value)) return value.map((item) => redactObserverValue(item, config));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    redactObserverValue(item, config, childKey),
  ]));
}

export function sanitizeObserverAuditMetadata(metadata = {}, config = {}) {
  const allowed = new Set(['route', 'method', 'remote_address', 'user_agent', 'reason', 'resource_id']);
  return Object.fromEntries(Object.entries(metadata || {})
    .filter(([key]) => allowed.has(key))
    .map(([key, value]) => [key, redactObserverValue(value, config, key)]));
}
