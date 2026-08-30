import {
  cleanupReservationForWorktree,
  comparableCleanupPath,
  readSessionRegistry,
} from '../hooks/obsidian-common.mjs';
import {
  markActiveContextCleanupTerminal,
  mutateActiveContext,
  releaseActiveContextCleanup,
  reserveActiveContextCleanup,
  updateActiveContextCleanupPhase,
} from '../hooks/active-context-store.mjs';
import { configureWorktreeCleanupComposition } from '../packages/worktrees/src/worktree-cleanup.mjs';

configureWorktreeCleanupComposition({
  cleanupReservationForWorktree,
  comparableCleanupPath,
  readSessionRegistry,
  markActiveContextCleanupTerminal,
  mutateActiveContext,
  releaseActiveContextCleanup,
  reserveActiveContextCleanup,
  updateActiveContextCleanupPhase,
});

export * from '../packages/worktrees/src/worktree-cleanup.mjs';
