import {
  activeContextKey,
  resolveActiveContext,
} from '../hooks/active-context-store.mjs';
import { parseTasks } from '../hooks/change-core.mjs';
import { buildEffectiveRequirementPackage } from '../hooks/spec-core.mjs';
import {
  buildTaskContractSnapshot as buildCanonicalTaskContractSnapshot,
} from '../packages/contracts/src/task-contracts.mjs';

export * from '../packages/contracts/src/task-contracts.mjs';

export function buildTaskContractSnapshot(options = {}) {
  return buildCanonicalTaskContractSnapshot(options, {
    activeContextKey,
    buildEffectiveRequirementPackage,
    parseTasks,
    resolveActiveContext,
  });
}
