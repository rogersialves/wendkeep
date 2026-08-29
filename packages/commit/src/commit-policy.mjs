import { assertPublicText } from './commit-input.mjs';

const IMPLEMENTATION_SUBJECT = /^(feat|fix|refactor|perf)(?:\([a-z0-9][a-z0-9._/-]*\))?: .+ \((?:ADR-\d{4,}|#\d+)\)$/;
const REQUIRED_SECTIONS = ['Capability', 'Evidence', 'Tasks', 'Tests', 'Scope'];

function occurrences(message, pattern) {
  return [...message.matchAll(pattern)].length;
}

function sectionItems(message, name) {
  const lines = message.split('\n');
  const index = lines.indexOf(`${name}:`);
  if (index < 0) return [];
  const items = [];
  for (let cursor = index + 1; cursor < lines.length && lines[cursor].startsWith('- '); cursor += 1) {
    items.push(lines[cursor]);
  }
  return items;
}

export function isGovernedCommitMessage(message) {
  const source = String(message ?? '').replace(/\r\n?/g, '\n');
  const first = source.split('\n', 1)[0];
  return /^WendKeep-Commit:\s*v1$/m.test(source)
    || /^(?:feat|fix|refactor|perf)(?:\([^)]*\))?!?:/.test(first);
}

export function validateCommitMessage(message) {
  const source = String(message ?? '').replace(/\r\n?/g, '\n').trimEnd();
  const governed = isGovernedCommitMessage(source);
  const errors = [];
  try {
    assertPublicText(source, 'commit message');
  } catch (error) {
    errors.push(error.code === 'WENDKEEP_COMMIT_SECRET'
      ? 'commit message contains a possible secret'
      : 'commit message contains a private or absolute path');
  }
  if (!governed) return { ok: errors.length === 0, governed: false, errors };

  const first = source.split('\n', 1)[0];
  if (!IMPLEMENTATION_SUBJECT.test(first)) {
    errors.push('implementation subject must be Conventional Commit and end with (ADR-NNNN) or (#NNN)');
  }
  for (const name of REQUIRED_SECTIONS) {
    const count = occurrences(source, new RegExp(`^${name}:$`, 'gm'));
    if (count !== 1) errors.push(`${name} section must appear exactly once`);
    if (count === 1 && !new RegExp(`^${name}:\\n- \\S`, 'm').test(source)) {
      errors.push(`${name} section must contain at least one item`);
    }
  }
  const evidence = sectionItems(source, 'Evidence');
  if (new Set(evidence).size !== evidence.length) errors.push('Evidence items must be unique');
  for (const item of evidence) {
    if (!/^- \[verified\] (?:adr|design|spec|task): \S/.test(item)) {
      errors.push('Evidence items must be remotely verified public artifact references');
    }
  }
  if (occurrences(source, /^WendKeep-Commit:\s*v1$/gm) !== 1) {
    errors.push('WendKeep-Commit: v1 trailer must appear exactly once');
  }
  if (occurrences(source, /^Remote-Proof-Scope:/gm) !== 1
    || !/^Remote-Proof-Scope:\s*git,authority,tasks,spec,sensors$/m.test(source)) {
    errors.push('Remote-Proof-Scope trailer must declare the canonical observable proof set exactly once');
  }
  if (occurrences(source, /^Local-Causal-Proof:/gm) !== 1
    || !/^Local-Causal-Proof:\s*unpublished$/m.test(source)) {
    errors.push('Local-Causal-Proof trailer must remain unpublished exactly once');
  }
  const subjectAuthority = first.match(/\((ADR-\d{4,}|#\d+)\)$/)?.[1] || '';
  if (subjectAuthority.startsWith('ADR-')) {
    const adrTrailers = source.match(/^ADR:/gm) || [];
    const trailerAdr = source.match(/^ADR:\s*(ADR-\d{4,})$/m)?.[1];
    if (adrTrailers.length !== 1) errors.push('ADR trailer must appear exactly once');
    if (!trailerAdr || trailerAdr !== subjectAuthority) errors.push('ADR trailer must match the subject ADR');
    if ((source.match(/^Refs:/gm) || []).length > 1) errors.push('Refs trailer must not be ambiguous');
    if (/^Authority:/m.test(source)) {
      errors.push('ADR authority cannot also claim native-no-causal-change');
    }
  } else if (subjectAuthority.startsWith('#')) {
    const native = source.match(/^Authority:/gm) || [];
    const issues = source.match(/^Issue:/gm) || [];
    const designs = source.match(/^Design:/gm) || [];
    const issue = source.match(/^Issue:\s*(#\d+)$/m)?.[1];
    const design = source.match(/^Design:\s*(\S+)$/m)?.[1];
    if (native.length !== 1) errors.push('native authority trailer must appear exactly once');
    if (issues.length !== 1) errors.push('Issue trailer must appear exactly once');
    if (designs.length !== 1) errors.push('Design trailer must appear exactly once');
    if (issue !== subjectAuthority) errors.push('Issue trailer must match the subject issue');
    if (!design || !/^(?:docs\/superpowers\/specs|plans)\/[a-zA-Z0-9._/-]+\.md$/.test(design)
      || design.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      errors.push('Design trailer must reference a versioned design path');
    }
    if (/^ADR:/m.test(source)) errors.push('native authority cannot also claim an ADR');
  }
  if (!/^Scope:\n(?:- .*\n)*- staged-diff-sha256: [a-f0-9]{64}(?:\n|$)/m.test(`${source}\n`)) {
    errors.push('Scope must contain the staged diff SHA-256');
  }
  if (/^Co-Authored-By:/mi.test(source)) errors.push('Co-Authored-By is omitted unless resolved from a trusted identity registry');
  return { ok: errors.length === 0, governed: true, errors };
}

export function messageScope(message) {
  const source = String(message ?? '').replace(/\r\n?/g, '\n');
  const items = sectionItems(source, 'Scope').map((line) => line.slice(2));
  const hashItem = items.find((item) => item.startsWith('staged-diff-sha256: ')) || '';
  return {
    sha256: hashItem.slice('staged-diff-sha256: '.length),
    files: items.filter((item) => !item.startsWith('staged-diff-sha256: ')),
  };
}

export function messageEvidence(message) {
  return sectionItems(String(message ?? '').replace(/\r\n?/g, '\n'), 'Evidence').map((line) => {
    const match = line.match(/^- \[(fresh|verified)\] (adr|design|evidence|receipt|spec|task|verdict): (\S.*)$/);
    return match ? { status: match[1], kind: match[2], ref: match[3] } : null;
  }).filter(Boolean);
}

export function messageTasks(message) {
  return sectionItems(String(message ?? '').replace(/\r\n?/g, '\n'), 'Tasks').map((line) => line.slice(2));
}

export function messageTests(message) {
  return sectionItems(String(message ?? '').replace(/\r\n?/g, '\n'), 'Tests').map((line) => line.slice(2));
}

export function nativeDesignReference(message) {
  const source = String(message ?? '').replace(/\r\n?/g, '\n');
  if (!/^Authority:\s*native-no-causal-change$/m.test(source)) return '';
  return source.match(/^Design:\s*(\S+)$/m)?.[1] || '';
}

export function assertValidCommitMessage(message) {
  const result = validateCommitMessage(message);
  if (!result.ok) {
    const error = new Error(result.errors.join('\n'));
    error.name = 'CommitMessageValidationError';
    error.code = 'WENDKEEP_COMMIT_MESSAGE_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return result;
}
