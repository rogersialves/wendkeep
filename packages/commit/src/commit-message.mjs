import { normalizeCommitInput } from './commit-input.mjs';

function section(name, values) {
  if (!values.length) return '';
  return `${name}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function subjectLine(input) {
  const scope = input.subject.scope ? `(${input.subject.scope})` : '';
  const authority = input.authority.kind === 'adr' ? input.authority.adr : input.authority.issue;
  return `${input.subject.type}${scope}: ${input.subject.summary} (${authority})`;
}

export function renderCommitMessage(value) {
  const input = normalizeCommitInput(value, { resolved: true });
  const body = [
    subjectLine(input),
    section('Capability', [input.capability]),
    section('Evidence', input.evidence.map((item) => `[${item.status}] ${item.kind}: ${item.ref}`)),
    section('Tasks', input.tasks),
    section('Tests', input.tests),
    section('Scope', [
      ...input.staged_diff.files,
      `staged-diff-sha256: ${input.staged_diff.sha256}`,
    ]),
    section('Limits', input.limits),
    [
      'WendKeep-Commit: v1',
      'Remote-Proof-Scope: git,authority,tasks,spec,sensors',
      'Local-Causal-Proof: unpublished',
      ...(input.authority.kind === 'adr'
        ? [
            `ADR: ${input.authority.adr}`,
            ...(input.authority.issue ? [`Refs: ${input.authority.issue}`] : []),
          ]
        : [
            'Authority: native-no-causal-change',
            `Issue: ${input.authority.issue}`,
            `Design: ${input.authority.design}`,
          ]),
    ].join('\n'),
  ].filter(Boolean);
  return `${body.join('\n\n')}\n`;
}

export function prepareCommitMessage(current, input, { source = '' } = {}) {
  const existing = String(current ?? '').replace(/\r\n?/g, '\n');
  if (source || /^WendKeep-Commit:\s*v1$/m.test(existing)) return existing;
  if (!input) return existing;
  return renderCommitMessage(input);
}
