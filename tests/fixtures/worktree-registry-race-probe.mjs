import {
  discoverWorktreeRepository,
  mutateWorktreeRegistry,
} from '../../packages/vault/src/worktree-metadata.mjs';

const [, , repo, slug] = process.argv;
const repository = discoverWorktreeRepository({ startDir: repo });

mutateWorktreeRegistry(repository, (registry) => ({
  ...registry,
  entries: {
    ...registry.entries,
    [slug]: {
      slug,
      state: 'creating',
    },
  },
}));
