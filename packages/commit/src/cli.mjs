import { readFileSync } from 'node:fs';

import { renderCommitMessage } from './commit-message.mjs';
import {
  buildCommitInput,
  clearCommitContext,
  prepareCommitMessageFile,
  validateCommitMessageFile,
  writeCommitContext,
} from './git-runtime.mjs';

export const COMMIT_HELP = `wendkeep commit — evidence-based Git commit policy

Usage:
  wendkeep commit context --input <json|-> [--json]
  wendkeep commit context --clear [--json]
  wendkeep commit render --input <json|->
  wendkeep commit prepare --message-file <path> [--source <source>]
  wendkeep commit validate --message-file <path> [--consume-context] [--json]

The context is stored under the repository Git directory, never in the Vault or working tree.
`;

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function readInput(path) {
  if (!path) throw Object.assign(new Error('--input is required'), { code: 'WENDKEEP_COMMIT_ARGUMENT' });
  const source = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  return JSON.parse(source);
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function runCommit(argv, { cwd = process.cwd() } = {}) {
  const [subcommand, ...rest] = argv;
  const json = rest.includes('--json');
  try {
    if (!subcommand || subcommand === 'help' || rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(COMMIT_HELP);
      return 0;
    }
    if (subcommand === 'context') {
      const result = rest.includes('--clear')
        ? clearCommitContext({ cwd })
        : writeCommitContext(readInput(option(rest, '--input')), { cwd });
      if (json) outputJson(rest.includes('--clear') ? result : { path: result.path, schema_version: 1 });
      else process.stdout.write(`${rest.includes('--clear') ? 'cleared' : 'written'}: ${result.path}\n`);
      return 0;
    }
    if (subcommand === 'render') {
      const input = buildCommitInput(readInput(option(rest, '--input')), { cwd });
      process.stdout.write(renderCommitMessage(input));
      return 0;
    }
    if (subcommand === 'prepare') {
      const result = prepareCommitMessageFile({
        messageFile: option(rest, '--message-file'),
        source: option(rest, '--source'),
        cwd,
      });
      if (json) outputJson(result);
      return 0;
    }
    if (subcommand === 'validate') {
      const result = validateCommitMessageFile({
        messageFile: option(rest, '--message-file'),
        consumeContext: rest.includes('--consume-context'),
        cwd,
      });
      if (json) outputJson(result);
      if (!result.ok) {
        process.stderr.write(`WENDKEEP_COMMIT_MESSAGE_INVALID\n${result.errors.map((error) => `- ${error}`).join('\n')}\n`);
        return 1;
      }
      return 0;
    }
    process.stderr.write(`wendkeep commit: unknown subcommand "${subcommand}"\n`);
    return 2;
  } catch (error) {
    process.stderr.write(`${error.code || 'WENDKEEP_COMMIT_ERROR'}: ${error.message}\n`);
    return 2;
  }
}
