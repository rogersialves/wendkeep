#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, '.github', 'required-checks.json'), 'utf8'));
if (config.schema_version !== 1 || config.branch !== 'main' || config.strict !== true
  || !Array.isArray(config.checks) || !config.checks.length
  || new Set(config.checks).size !== config.checks.length) {
  throw new Error('required-checks configuration is invalid');
}
const workflowText = ['test.yml', 'codeql.yml', 'dependency-review.yml']
  .map((name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8'))
  .join('\n');
for (const check of config.checks) {
  if (!workflowText.includes(`name: ${check}`)) throw new Error(`required check is not declared: ${check}`);
}
process.stdout.write(`${JSON.stringify({
  branch: config.branch,
  required_status_checks: { strict: config.strict, contexts: config.checks },
}, null, 2)}\n`);
