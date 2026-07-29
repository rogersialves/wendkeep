export function emptyTokenUsage() {
  return {
    input: 0,
    cached: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

export function normalizeCodexUsage(raw = {}) {
  const inputAll = Number(raw.input_tokens || 0);
  const cached = Math.min(Number(raw.cached_input_tokens || 0), inputAll);
  const output = Number(raw.output_tokens || 0);
  return {
    input: inputAll - cached,
    cached,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output,
    reasoning: Number(raw.reasoning_output_tokens || 0),
    total: Number(raw.total_tokens || 0) || inputAll + output,
  };
}

export function normalizeClaudeUsage(raw = {}) {
  const input = Number(raw.input_tokens || 0);
  const cached = Number(raw.cache_read_input_tokens || 0);
  const cacheWrite = Number(raw.cache_creation_input_tokens || 0);
  const cacheWrite1h = Number(raw.cache_creation?.ephemeral_1h_input_tokens || 0);
  const output = Number(raw.output_tokens || 0);
  return {
    input,
    cached,
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite1h, cacheWrite),
    output,
    reasoning: 0,
    total: input + cached + cacheWrite + output,
  };
}

export function addUsage(target, usage) {
  target.input += usage.input;
  target.cached += usage.cached;
  target.cacheWrite += usage.cacheWrite;
  target.cacheWrite1h += usage.cacheWrite1h;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.total += usage.total;
}
