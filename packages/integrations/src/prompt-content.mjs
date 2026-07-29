export function isBootstrapPrompt(text = '') {
  const clean = String(text || '').trim();
  return clean.startsWith('# AGENTS.md instructions')
    || clean.startsWith('<environment_context>')
    || clean.startsWith('<permissions instructions>')
    || clean.startsWith('<recommended_plugins>')
    || clean.includes('You are Codex, a coding agent')
    || clean.startsWith('## Memory');
}

export function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(whsec_[A-Za-z0-9_/-]{8,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED_SECRET]')
    .replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://[REDACTED_SECRET]@');
}
