import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { basename } from 'node:path';

import { copyGitFixture, git } from './helpers/git-fixture.mjs';

test('TEST-1: cópias de fixture Git são independentes', () => {
  const setup = (root) => {
    writeFileSync(`${root}/state.txt`, 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
  };
  const first = copyGitFixture('fixture-contract', setup);
  const second = copyGitFixture('fixture-contract', setup);

  writeFileSync(`${first}/state.txt`, 'first-only\n');
  git(first, 'add', 'state.txt');
  git(first, 'commit', '-qm', 'first-only');

  assert.equal(basename(git(first, 'rev-parse', '--show-toplevel')), basename(first));
  assert.equal(readFileSync(`${first}/state.txt`, 'utf8'), 'first-only\n');
  assert.equal(readFileSync(`${second}/state.txt`, 'utf8'), 'base\n');
  assert.notEqual(git(first, 'rev-parse', 'HEAD'), git(second, 'rev-parse', 'HEAD'));
});
