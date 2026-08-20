export function resolveObserverToken(value = '') {
  return String(value || process.env.WENDKEEP_OBSERVER_TOKEN || '').trim();
}

export function observerAuthHeaders(token, headers = {}) {
  const resolved = resolveObserverToken(token);
  return resolved
    ? { ...headers, authorization: `Bearer ${resolved}` }
    : { ...headers };
}
