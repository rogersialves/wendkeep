const EVENT_CAPABILITIES = {
  session_start: 'session.start',
  session_resume: 'session.resume',
  session_stop: 'session.stop',
  prompt_submit: 'prompt.submit',
  tool_pre: 'tool.pre',
};

export function piAdapterDescriptor() {
  return {
    schema_version: 1,
    host_id: 'pi',
    adapter_version: 1,
    transport: 'extension',
    envelope_version: 1,
  };
}

export function normalizePiLifecycleEvent(input = {}) {
  const capability = EVENT_CAPABILITIES[String(input.type || '')];
  if (!capability) return { ok: false, code: 'PI_ENVELOPE_UNKNOWN' };
  return {
    schema_version: 1,
    host_id: 'pi',
    capability,
    session_id: String(input.sessionId || input.session_id || ''),
    authority: 'adapted',
  };
}
