import assert from 'node:assert/strict';
import test from 'node:test';

import { assessUnpublishedPackageVersion } from '../scripts/check-unpublished-version.mjs';

test('[req:RECALL-13] release preflight distinguishes unpublished, published, and stale versions', () => {
  assert.deepEqual(
    assessUnpublishedPackageVersion({ packageVersion: '0.86.0', publishedVersion: '0.85.1' }),
    {
      ok: true,
      package_version: '0.86.0',
      published_version: '0.85.1',
      status: 'unpublished',
    },
  );
  assert.equal(
    assessUnpublishedPackageVersion({ packageVersion: '0.86.0', publishedVersion: '0.86.0' }).status,
    'already-published',
  );
  assert.equal(
    assessUnpublishedPackageVersion({ packageVersion: '0.85.1', publishedVersion: '0.86.0' }).status,
    'package-behind',
  );
});
