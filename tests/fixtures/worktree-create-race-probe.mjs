import { createManagedWorktree } from '../../src/worktree.mjs';

const [, , repo, slug] = process.argv;
createManagedWorktree({ startDir: repo, slug, open: 'none' });
