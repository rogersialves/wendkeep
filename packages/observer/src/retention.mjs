import { purgeObserverData } from './purge.mjs';

const CLASSES = ['documents', 'calls', 'transcripts'];

export function observerRetentionCutoffs(policy = {}, now = new Date()) {
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw Object.assign(new Error('retention clock inválido.'), { code: 'observer_retention_invalid' });
  return Object.fromEntries(CLASSES.flatMap((dataClass) => {
    const days = Number(policy[dataClass] ?? 0);
    if (!Number.isInteger(days) || days < 0) throw Object.assign(new Error(`retention inválida para ${dataClass}.`), { code: 'observer_retention_invalid' });
    return days === 0 ? [] : [[dataClass, new Date(timestamp.getTime() - days * 86_400_000).toISOString()]];
  }));
}

export function runObserverRetention(db, {
  projectId, policy = {}, clock = () => new Date(), dryRun = false, operationId = '', receiptSink,
} = {}) {
  const observedAt = clock();
  const cutoffs = observerRetentionCutoffs(policy, observedAt);
  const receipts = [];
  for (const [dataClass, before] of Object.entries(cutoffs)) {
    receipts.push(purgeObserverData(db, {
      projectId,
      before,
      classes: [dataClass],
      dryRun,
      operationId: operationId ? `${operationId}:${dataClass}` : '',
      now: observedAt,
      receiptSink,
    }));
  }
  return {
    schema_version: 1,
    project_id: projectId,
    observed_at: new Date(observedAt).toISOString(),
    cutoffs,
    receipts,
  };
}
