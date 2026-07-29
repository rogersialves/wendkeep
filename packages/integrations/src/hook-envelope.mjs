// Pure host-envelope rules. This module deliberately has no ambient process or I/O access:
// legacy adapters inject stdin, stdout, and environment at their boundary.

// Codex on Windows can serialize a Stop payload with the final
// `last_assistant_message` cut mid-string. Everything consumed by WendKeep precedes that
// field, so retain the last complete top-level object prefix without inventing truncated
// content. A single pass avoids repeatedly parsing payloads that may be tens of KB.
export function salvageTruncatedJson(raw) {
  const text = String(raw ?? '');
  if (text[0] !== '{') return null;

  let inString = false;
  let escaped = false;
  let depth = 0;
  let lastBoundary = -1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    else if (character === ',' && depth === 1) lastBoundary = index;
  }

  if (lastBoundary === -1) return null;
  try {
    const parsed = JSON.parse(`${text.slice(0, lastBoundary)}}`);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseHookInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    const salvaged = salvageTruncatedJson(text);
    if (salvaged) return { ...salvaged, _wkSalvaged: true };
    throw error;
  }
}

export function stringifyHookOutput(payload = {}) {
  return JSON.stringify(payload);
}

export function detectProvider(environment = {}) {
  if (environment.CLAUDECODE === '1'
    || environment.CLAUDE_CODE_SESSION_ID
    || environment.CLAUDE_PROJECT_DIR) {
    return 'claude';
  }
  return 'codex';
}

export function providerMeta(provider) {
  if (provider === 'claude') {
    return { id: 'claude', label: 'Claude Code', tag: 'claude', source: 'claude-hook' };
  }
  return { id: 'codex', label: 'Codex', tag: 'codex', source: 'codex-hook' };
}

export function extractHookPrompt(input = {}) {
  const candidates = [
    input.prompt,
    input.user_prompt,
    input.userPrompt,
    input.message,
    input.input,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  if (Array.isArray(input.messages)) {
    const text = input.messages
      .map((message) => message?.content || message?.text || '')
      .filter((item) => typeof item === 'string' && item.trim())
      .join('\n')
      .trim();
    if (text) return text;
  }

  return '';
}
