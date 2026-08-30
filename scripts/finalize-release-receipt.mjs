#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { finalizeReleaseReceipt } from './generate-sbom.mjs';

const [, , candidatePath, publishedPath, outputPath] = process.argv;
if (!candidatePath || !publishedPath || !outputPath) {
  process.stderr.write('usage: finalize-release-receipt <candidate.json> <published.json> <output.json>\n');
  process.exit(2);
}
const receipt = finalizeReleaseReceipt(
  JSON.parse(readFileSync(candidatePath, 'utf8')),
  JSON.parse(readFileSync(publishedPath, 'utf8')),
);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
