import {
  readMemoryLedgerGeneration as readStoredMemoryLedgerGeneration,
  readMemoryRotationJournal,
} from './memory-ledger-view-base.mjs';

export * from './memory-ledger-view-base.mjs';

/**
 * Expose the persisted generation normally, but model the single atomic transition where
 * a switched active ledger still points at the previous generation state as "not published".
 * The rotation writer can then replace that previous state after proving the journal's
 * previous_generation and previous_state_hash bindings. Other stages retain the persisted view.
 */
export function readMemoryLedgerGeneration(vaultBase) {
  const current = readStoredMemoryLedgerGeneration(vaultBase);
  if (current.status !== 'ok') return current;

  const journal = readMemoryRotationJournal(vaultBase);
  const plan = journal.journal?.plan;
  const transitioning = journal.status === 'ok'
    && journal.journal.stage === 'switched'
    && Number(plan?.generation) === current.state.generation + 1
    && Number(plan?.previous_generation) === current.state.generation
    && plan?.previous_state_hash === current.state.state_hash
    && plan?.generation_state?.previous_state_hash === current.state.state_hash
    && Number(plan?.generation_state?.previous_generation) === current.state.generation;

  if (!transitioning) return current;
  return {
    status: 'missing',
    projectId: current.projectId,
    state: null,
    raw: null,
    errors: [],
    transition: {
      operationId: journal.journal.operation_id,
      fromGeneration: current.state.generation,
      toGeneration: plan.generation,
    },
  };
}
