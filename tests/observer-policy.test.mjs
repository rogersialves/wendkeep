import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  OBSERVER_EVENT_STRUCTURAL_CONTRACT,
  createObserverPolicy,
  evaluateObserverPolicy,
  protectObserverEvent,
  saveObserverPolicy,
} from '../packages/observer/src/policy.mjs';
import { redactObserverValue } from '../packages/observer/src/redaction.mjs';
import {
  configureObserverDatabaseSecurity,
  ensureObserverDatabase,
  ingestObserverEvents,
  registerSqlProject,
} from '../src/observer-sql-store.mjs';
import { makeDataDir } from './helpers/observer-fixture.mjs';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

const expectedStructuralContract = {
  envelope: {
    strings: ['event_id', 'kind', 'project_id'],
    integers: ['schema_version'],
    timestamps: ['occurred_at'],
  },
  payload: {
    'document.upsert': {
      strings: ['document_id', 'documentId', 'logical_path', 'logicalPath', 'entity_type', 'entityType', 'source_session_id', 'sourceSessionId', 'source_turn_id', 'sourceTurnId', 'operation', 'op'],
      integers: ['revision'],
      timestamps: ['captured_at', 'capturedAt'],
    },
    'document.delete': {
      strings: ['logical_path', 'logicalPath', 'entity_type', 'entityType', 'source_session_id', 'sourceSessionId', 'source_turn_id', 'sourceTurnId', 'operation', 'op'],
      integers: ['revision'],
      timestamps: [],
    },
    'session.upsert': {
      strings: ['session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug'],
      integers: [],
      timestamps: ['started_at', 'startedAt', 'ended_at', 'endedAt'],
    },
    'agent.upsert': {
      strings: ['session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug', 'agent_id', 'agentId', 'parent_agent_id', 'parentAgentId', 'role', 'agent_type', 'agentType', 'workflow', 'model', 'effort'],
      integers: [],
      timestamps: ['started_at', 'startedAt', 'ended_at', 'endedAt'],
    },
    'usage.rollup': {
      strings: ['session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug', 'agent_id', 'agentId', 'parent_agent_id', 'parentAgentId', 'role', 'agent_type', 'agentType', 'workflow', 'model', 'effort', 'rollup_key', 'rollupKey', 'model_provider', 'modelProvider', 'cost_status', 'costStatus', 'pricing_source', 'pricingSource', 'pricing_version', 'pricingVersion'],
      integers: ['revision'],
      timestamps: ['started_at', 'startedAt', 'ended_at', 'endedAt'],
    },
    llm_call: {
      strings: ['session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug', 'agent_id', 'agentId', 'parent_agent_id', 'parentAgentId', 'role', 'agent_type', 'agentType', 'workflow', 'model', 'effort', 'call_id', 'callId', 'model_provider', 'modelProvider', 'cost_status', 'costStatus', 'transcript_id', 'transcriptId'],
      integers: ['sequence'],
      timestamps: ['started_at', 'startedAt', 'ended_at', 'endedAt', 'occurred_at'],
    },
    'transcript.upsert': {
      strings: ['session_id', 'sessionId', 'provider', 'status', 'change_slug', 'changeSlug', 'agent_id', 'agentId', 'parent_agent_id', 'parentAgentId', 'role', 'agent_type', 'agentType', 'workflow', 'model', 'effort', 'transcript_id', 'transcriptId', 'coverage', 'source'],
      integers: [],
      timestamps: ['started_at', 'startedAt', 'ended_at', 'endedAt'],
    },
  },
};

test('[req:OBS-SEC-POLICY] structural contract enumerates every store identity and accepted alias', () => {
  assert.deepEqual(OBSERVER_EVENT_STRUCTURAL_CONTRACT, expectedStructuralContract);
});

test('[req:OBS-SEC-POLICY] content rules preserve every typed structural field by event kind', () => {
  const structuralPolicy = createObserverPolicy({
    document_capture: 'full',
    transcript_capture: 'full',
    usage_capture: 'calls',
    prompt_capture: 'redacted',
    response_capture: 'redacted',
    redaction: { rules: [{ pattern: 'customer-[0-9]+|2026', replacement: '[CONTENT]' }] },
  });
  for (const [kind, contract] of Object.entries(expectedStructuralContract.payload)) {
    const payload = {
      content: 'customer-123 content from 2026',
      title: 'customer-123 title',
      summary: 'customer-123 summary',
      agent_name: 'customer-123 display name',
      prompt: 'customer-123 prompt',
      response: 'customer-123 response',
      metadata: { note: 'customer-123 metadata' },
    };
    for (const field of contract.strings) {
      payload[field] = field === 'logical_path' || field === 'logicalPath'
        ? `08-Mudanças/customer-123-${field}.md`
        : `customer-123-${field}`;
    }
    for (const field of contract.integers) payload[field] = 7;
    for (const field of contract.timestamps) payload[field] = '2026-08-29T14:00:00.000Z';
    const event = {
      schema_version: 1,
      event_id: 'customer-123-event',
      kind,
      project_id: 'customer-123-project',
      occurred_at: '2026-08-29T14:00:00.000Z',
      payload,
    };
    const protectedEvent = protectObserverEvent(event, { policy: structuralPolicy });

    for (const field of expectedStructuralContract.envelope.strings) assert.equal(protectedEvent[field], event[field], `${kind}:${field}`);
    for (const field of expectedStructuralContract.envelope.integers) assert.equal(protectedEvent[field], event[field], `${kind}:${field}`);
    for (const field of expectedStructuralContract.envelope.timestamps) assert.equal(protectedEvent[field], event[field], `${kind}:${field}`);
    for (const field of contract.strings) assert.equal(protectedEvent.payload[field], payload[field], `${kind}:${field}`);
    for (const field of contract.integers) assert.equal(protectedEvent.payload[field], payload[field], `${kind}:${field}`);
    for (const field of contract.timestamps) assert.equal(protectedEvent.payload[field], payload[field], `${kind}:${field}`);

    const serialized = JSON.stringify(protectedEvent.payload);
    if (kind === 'document.delete') assert.equal(Object.hasOwn(protectedEvent.payload, 'content'), false);
    else assert.doesNotMatch(serialized, /customer-123 (?:content|title|summary|display name|prompt|response|metadata)/u, kind);
  }
});

const policy = createObserverPolicy({
  document_capture: 'metadata',
  transcript_capture: 'metadata',
  prompt_capture: 'redacted',
  response_capture: 'redacted',
  usage_capture: 'aggregate',
  rules: [
    { project_id: 'project-a', data_class: 'document', path: '04-Decisões/**', capture: 'full' },
    { project_id: 'project-a', data_class: 'transcript', entity_type: 'session', capture: 'none' },
  ],
  redaction: {
    rules: [{ pattern: '\\bcustomer-[0-9]+\\b', replacement: '[CUSTOMER]' }],
  },
});

test('[req:OBS-SEC-POLICY] policy is scoped by project, class, path and entity without authority bleed', () => {
  assert.equal(evaluateObserverPolicy(policy, {
    projectId: 'project-a', dataClass: 'document', path: '04-Decisões/ADR-1.md', entityType: 'decision',
  }).capture, 'full');
  assert.equal(evaluateObserverPolicy(policy, {
    projectId: 'project-b', dataClass: 'document', path: '04-Decisões/ADR-1.md', entityType: 'decision',
  }).capture, 'metadata');
  assert.equal(evaluateObserverPolicy(policy, {
    projectId: 'project-a', dataClass: 'transcript', path: '', entityType: 'session',
  }).capture, 'none');
});

test('[req:OBS-SEC-POLICY] metadata capture never forwards full document or transcript content', () => {
  const document = protectObserverEvent({
    schema_version: 1,
    event_id: 'document-b',
    kind: 'document.upsert',
    project_id: 'project-b',
    occurred_at: '2026-08-29T12:00:00.000Z',
    payload: {
      logical_path: '02-Sessões/private.md', entity_type: 'session', content: 'secret document',
      metadata: { transcript_path: 'C:\\private\\trace.jsonl' },
    },
  }, { policy });
  assert.equal(document.payload.content, '');
  assert.equal(document.payload.metadata.transcript_path, 'trace.jsonl');
  assert.equal(document.payload.capture, 'metadata');

  const transcript = protectObserverEvent({
    schema_version: 1,
    event_id: 'transcript-b',
    kind: 'transcript.upsert',
    project_id: 'project-b',
    occurred_at: '2026-08-29T12:00:00.000Z',
    payload: { transcript_id: 't-1', entity_type: 'agent', coverage: 'complete', content: 'secret transcript' },
  }, { policy });
  assert.equal(transcript.payload.content, '');
  assert.equal(transcript.payload.coverage, 'summary_only');
  assert.equal(transcript.payload.capture, 'metadata');
});

test('[req:OBS-SEC-POLICY] protected upsert hashes bind transformed content instead of the input hash', () => {
  const content = 'Email roger@example.test\nAuthorization: Bearer abc.def.ghi\nAccount customer-123\n';
  const expectedContent = 'Email [EMAIL]\nAuthorization: Bearer [REDACTED]\nAccount [CUSTOMER]\n';
  const inputHash = sha256(content);
  const expectedHash = sha256(expectedContent);
  const redaction = { rules: [{ pattern: '\\bcustomer-[0-9]+\\b', replacement: '[CUSTOMER]' }] };

  for (const [kind, capture] of [
    ['document.upsert', { document_capture: 'full', redaction }],
    ['transcript.upsert', { transcript_capture: 'full', redaction }],
  ]) {
    const protectedEvent = protectObserverEvent({
      kind,
      project_id: 'project-a',
      payload: {
        logical_path: '08-Mudanças/change-a/proposta.md',
        entity_type: kind.startsWith('document.') ? 'change' : 'session',
        content,
        content_hash: inputHash,
      },
    }, { policy: createObserverPolicy(capture) });

    assert.equal(protectedEvent.payload.content, expectedContent, kind);
    assert.equal(protectedEvent.payload.content_hash, expectedHash, kind);
    assert.equal(protectedEvent.payload.content_hash, sha256(protectedEvent.payload.content), kind);
    assert.notEqual(protectedEvent.payload.content_hash, inputHash, `${kind} must not trust the input hash`);
    assert.doesNotMatch(protectedEvent.payload.content, /roger|abc\.def\.ghi|customer-123/u, kind);
  }
});

test('[req:OBS-SEC-POLICY] metadata and selected capture use canonical empty-content hashes', () => {
  const content = 'private content';
  const inputHash = sha256(content);
  for (const [kind, capture, expectedCapture] of [
    ['document.upsert', { document_capture: 'metadata' }, 'metadata'],
    ['document.upsert', { document_capture: 'selected' }, 'selected'],
    ['transcript.upsert', { transcript_capture: 'metadata' }, 'metadata'],
  ]) {
    const protectedEvent = protectObserverEvent({
      kind,
      project_id: 'project-a',
      payload: { logical_path: 'private.md', entity_type: 'session', content, content_hash: inputHash },
    }, { policy: createObserverPolicy(capture) });

    assert.equal(protectedEvent.payload.content, '', `${kind}:${expectedCapture}`);
    assert.equal(protectedEvent.payload.content_hash, sha256(''), `${kind}:${expectedCapture}`);
    assert.notEqual(protectedEvent.payload.content_hash, inputHash, `${kind}:${expectedCapture}`);
    assert.equal(protectedEvent.payload.capture, expectedCapture, `${kind}:${expectedCapture}`);
  }
});

test('[req:OBS-SEC-POLICY] document delete preserves its operation metadata without inventing content integrity fields', () => {
  const protectedEvent = protectObserverEvent({
    kind: 'document.delete',
    project_id: 'project-a',
    payload: {
      logical_path: 'private.md', revision: 7, op: 'delete',
      content: 'stale body must not ride a delete', content_hash: 'stale-hash', contentHash: 'stale-camel-hash',
    },
  }, { policy: createObserverPolicy({ document_capture: 'none' }) });

  assert.ok(protectedEvent, 'delete must survive a policy that disables content capture');
  assert.equal(protectedEvent.payload.logical_path, 'private.md');
  assert.equal(protectedEvent.payload.revision, 7);
  assert.equal(protectedEvent.payload.op, 'delete');
  assert.equal(Object.hasOwn(protectedEvent.payload, 'content'), false);
  assert.equal(Object.hasOwn(protectedEvent.payload, 'content_hash'), false);
  assert.equal(Object.hasOwn(protectedEvent.payload, 'contentHash'), false);
});

test('[req:OBS-SEC-POLICY] content redaction cannot retarget document upsert, revision or delete identity', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  const logicalPath = '08-Mudanças/customer-123.md';
  const structuralPolicy = createObserverPolicy({
    document_capture: 'none',
    rules: [{ project_id: 'project-a', data_class: 'document', path: logicalPath, capture: 'full' }],
    redaction: { rules: [{ pattern: 'customer-[0-9]+', replacement: '[CUSTOMER]' }] },
  });
  const event = (eventId, kind, revision, content = undefined) => ({
    schema_version: 1,
    event_id: eventId,
    kind,
    project_id: 'project-a',
    occurred_at: `2026-08-29T12:0${revision}:00.000Z`,
    payload: {
      logical_path: logicalPath,
      entity_type: 'change',
      revision,
      op: kind === 'document.delete' ? 'delete' : 'upsert',
      ...(content === undefined ? {} : { content, content_hash: sha256(content) }),
    },
  });
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    configureObserverDatabaseSecurity(db, { policy: structuralPolicy, enforcePolicy: true });

    const firstContent = 'customer-123 owner roger@example.test';
    const blocked = event('structural-blocked-1', 'document.upsert', 1, firstContent);
    blocked.payload.logical_path = '08-Mudanças/customer-999.md';
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [blocked] }).dropped, 1);
    assert.equal(ingestObserverEvents(db, {
      projectId: 'project-a', events: [event('structural-upsert-1', 'document.upsert', 1, firstContent)],
    }).accepted, 1);
    const first = db.prepare('SELECT logical_path, content, content_hash, revision FROM documents WHERE project_id = ? AND logical_path = ?')
      .get('project-a', logicalPath);
    assert.deepEqual({ ...first }, {
      logical_path: logicalPath,
      content: '[CUSTOMER] owner [EMAIL]',
      content_hash: sha256('[CUSTOMER] owner [EMAIL]'),
      revision: 1,
    });

    const changedContent = 'customer-456 changed Bearer abc.def.ghi';
    assert.equal(ingestObserverEvents(db, {
      projectId: 'project-a', events: [event('structural-upsert-2', 'document.upsert', 2, changedContent)],
    }).accepted, 1);
    const changed = db.prepare('SELECT logical_path, content, content_hash, revision FROM documents WHERE project_id = ? AND logical_path = ?')
      .get('project-a', logicalPath);
    assert.deepEqual({ ...changed }, {
      logical_path: logicalPath,
      content: '[CUSTOMER] changed Bearer [REDACTED]',
      content_hash: sha256('[CUSTOMER] changed Bearer [REDACTED]'),
      revision: 2,
    });

    assert.equal(ingestObserverEvents(db, {
      projectId: 'project-a', events: [event('structural-delete-3', 'document.delete', 3)],
    }).accepted, 1);
    const deleted = db.prepare('SELECT logical_path, revision, deleted_at FROM documents WHERE project_id = ? AND logical_path = ?')
      .get('project-a', logicalPath);
    assert.equal(deleted.logical_path, logicalPath);
    assert.equal(deleted.revision, 3);
    assert.ok(deleted.deleted_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE logical_path LIKE '%[CUSTOMER]%'").get().count, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-POLICY] malformed structural identity fails closed before persistence', () => {
  for (const payload of [
    { logical_path: ['private.md'], revision: 1, content: 'body' },
    { logical_path: 'private.md', revision: '1', content: 'body' },
  ]) {
    assert.throws(
      () => protectObserverEvent({ kind: 'document.upsert', project_id: 'project-a', payload }, {
        policy: createObserverPolicy({ document_capture: 'full' }),
      }),
      (error) => error.code === 'observer_policy_invalid',
    );
  }
});

test('[req:OBS-SEC-POLICY] document primary identities cannot collapse under content redaction', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  const collisionPolicy = createObserverPolicy({
    document_capture: 'full',
    redaction: { rules: [{ pattern: 'customer-[0-9]+', replacement: '[CUSTOMER]' }] },
  });
  const document = (suffix) => {
    const content = `customer-${suffix} private body`;
    return {
      schema_version: 1,
      event_id: `document-collision-${suffix}`,
      kind: 'document.upsert',
      project_id: 'project-a',
      occurred_at: `2026-08-29T13:0${suffix}:00.000Z`,
      payload: {
        document_id: `customer-${suffix}`,
        logical_path: `08-Mudanças/customer-${suffix}.md`,
        entity_type: 'change',
        revision: 1,
        capturedAt: `2026-08-29T13:0${suffix}:30.000Z`,
        content,
        content_hash: sha256(content),
      },
    };
  };
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    configureObserverDatabaseSecurity(db, { policy: collisionPolicy, enforcePolicy: true });
    const result = ingestObserverEvents(db, { projectId: 'project-a', events: [document(1), document(2)] });
    assert.equal(result.accepted, 2);
    assert.equal(result.rejected, 0);
    assert.deepEqual(
      db.prepare('SELECT document_id, logical_path, captured_at FROM documents WHERE project_id = ? ORDER BY document_id').all('project-a')
        .map((row) => ({ ...row })),
      [
        { document_id: 'customer-1', logical_path: '08-Mudanças/customer-1.md', captured_at: '2026-08-29T13:01:30.000Z' },
        { document_id: 'customer-2', logical_path: '08-Mudanças/customer-2.md', captured_at: '2026-08-29T13:02:30.000Z' },
      ],
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-POLICY] fallback rollup dimensions cannot collapse under content redaction', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  const collisionPolicy = createObserverPolicy({
    usage_capture: 'aggregate',
    redaction: { rules: [{ pattern: 'customer-[0-9]+', replacement: '[CUSTOMER]' }] },
  });
  const rollup = (suffix) => ({
    schema_version: 1,
    event_id: `rollup-collision-${suffix}`,
    kind: 'usage.rollup',
    project_id: 'project-a',
    occurred_at: `2026-08-29T15:0${suffix}:00.000Z`,
    payload: {
      session_id: 'session-a',
      agent_id: 'agent-a',
      role: 'main',
      model_provider: `customer-${suffix}-provider`,
      model: `customer-${suffix}-model`,
      effort: `customer-${suffix}-effort`,
      calls: 1,
      tokens: { input: suffix, total: suffix },
      revision: 1,
      metadata: { note: `customer-${suffix} private metadata` },
    },
  });
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    configureObserverDatabaseSecurity(db, { policy: collisionPolicy, enforcePolicy: true });
    const result = ingestObserverEvents(db, { projectId: 'project-a', events: [rollup(1), rollup(2)] });
    assert.equal(result.accepted, 2);
    assert.equal(result.rejected, 0);
    assert.deepEqual(
      db.prepare('SELECT model_provider, model, effort, metadata_json FROM usage_rollups WHERE project_id = ? ORDER BY model_provider').all('project-a')
        .map((row) => ({ ...row, metadata_json: JSON.parse(row.metadata_json) })),
      [1, 2].map((suffix) => ({
        model_provider: `customer-${suffix}-provider`,
        model: `customer-${suffix}-model`,
        effort: `customer-${suffix}-effort`,
        metadata_json: { note: '[CUSTOMER] private metadata' },
      })),
    );
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[req:OBS-SEC-POLICY] selected/messages and usage none/aggregate/calls are discriminated fail-closed', () => {
  const document = protectObserverEvent({
    kind: 'document.upsert', project_id: 'project-a',
    payload: { logical_path: 'private.md', entity_type: 'document', content: 'never selected' },
  }, { policy: createObserverPolicy({ document_capture: 'selected' }) });
  assert.equal(document.payload.content, '');
  assert.equal(document.payload.capture, 'selected');

  const transcript = protectObserverEvent({
    kind: 'transcript.upsert', project_id: 'project-a',
    payload: { entity_type: 'session', content: JSON.stringify([
      { role: 'user', content: 'question' },
      { type: 'tool_result', content: 'private tool output' },
      { role: 'assistant', content: 'answer' },
    ]) },
  }, { policy: createObserverPolicy({ transcript_capture: 'messages' }) });
  assert.match(transcript.payload.content, /question/);
  assert.match(transcript.payload.content, /answer/);
  assert.doesNotMatch(transcript.payload.content, /private tool output/);

  const canonical = protectObserverEvent({
    kind: 'transcript.upsert', project_id: 'project-a',
    payload: { entity_type: 'session', content: JSON.stringify({
      type: 'rollout', session_secret: 'must disappear',
      messages: [
        { role: 'user', content: 'customer-123 question', message_id: 'private-id' },
        { role: 'tool', content: 'private tool output' },
        { role: 'assistant', content: 'answer', metadata: { trace: 'private trace' } },
        { role: 'user', content: { text: 'malformed object' } },
      ],
    }) },
  }, { policy: createObserverPolicy({
    transcript_capture: 'messages',
    redaction: { rules: [{ pattern: '\\bcustomer-[0-9]+\\b', replacement: '[CUSTOMER]' }] },
  }) });
  assert.deepEqual(JSON.parse(canonical.payload.content), { messages: [
    { role: 'user', content: '[CUSTOMER] question' },
    { role: 'assistant', content: 'answer' },
  ] });
  assert.equal(protectObserverEvent({
    kind: 'transcript.upsert', project_id: 'project-a', payload: { content: '{malformed' },
  }, { policy: createObserverPolicy({ transcript_capture: 'messages' }) }).payload.content, '');

  const rollup = { kind: 'usage.rollup', project_id: 'project-a', payload: { input_tokens: 10 } };
  const call = { kind: 'llm_call', project_id: 'project-a', payload: { prompt: 'secret prompt', response: 'secret response', input_tokens: 10 } };
  assert.equal(protectObserverEvent(rollup, { policy: createObserverPolicy({ usage_capture: 'none' }) }), null);
  assert.equal(protectObserverEvent(call, { policy: createObserverPolicy({ usage_capture: 'none' }) }), null);
  assert.ok(protectObserverEvent(rollup, { policy: createObserverPolicy({ usage_capture: 'aggregate' }) }));
  assert.equal(protectObserverEvent(call, { policy: createObserverPolicy({ usage_capture: 'aggregate' }) }), null);
  const protectedCall = protectObserverEvent(call, {
    policy: createObserverPolicy({ usage_capture: 'calls', prompt_capture: 'none', response_capture: 'redacted' }),
  });
  assert.equal(protectedCall.payload.prompt_text, '');
  assert.equal(protectedCall.payload.response_text, 'secret response');
  assert.equal(protectedCall.payload.prompt, undefined);
  assert.equal(protectedCall.payload.response, undefined);
});

test('[req:OBS-SEC-REDACT] redaction removes credentials, connection strings, tokens and configured PII recursively', () => {
  const source = {
    url: 'https://roger:super-secret@example.test/private',
    database: 'postgres://admin:hunter2@db.example.test/app',
    authorization: 'Bearer abc.def.ghi',
    note: 'customer-123 email roger@example.test phone +55 (11) 99999-9999',
    tokens: { input: 10, output: 20, total: 30 },
    token: 'raw-token-secret',
  };
  const redacted = redactObserverValue(source, policy.redaction);
  const serialized = JSON.stringify(redacted);
  for (const secret of ['super-secret', 'hunter2', 'abc.def.ghi', 'roger@example.test', '99999-9999', 'customer-123']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(redacted.note.includes('[CUSTOMER]'), true);
  assert.deepEqual(redacted.tokens, { input: 10, output: 20, total: 30 });
  assert.equal(redacted.token, '[REDACTED]');
});

test('[req:OBS-SEC-REDACT] policy rejects invalid or obviously explosive custom regular expressions', () => {
  assert.throws(
    () => createObserverPolicy({ redaction: { rules: [{ pattern: '[' }] } }),
    (error) => error.code === 'observer_policy_invalid',
  );
  assert.throws(
    () => createObserverPolicy({ redaction: { rules: [{ pattern: '(a+)+$' }] } }),
    (error) => error.code === 'observer_policy_invalid',
  );
});

test('[req:OBS-SEC-POLICY] secured ingestion resolves the current project policy without restart', () => {
  const dataDir = makeDataDir();
  const db = ensureObserverDatabase(dataDir);
  try {
    registerSqlProject(db, { projectId: 'project-a' });
    configureObserverDatabaseSecurity(db, { enforcePolicy: true });
    saveObserverPolicy(db, 'project-a', { document_capture: 'metadata' });
    const first = {
      schema_version: 1, event_id: 'policy-d-1', kind: 'document.upsert', project_id: 'project-a',
      occurred_at: '2026-08-29T12:00:00.000Z',
      payload: { logical_path: 'private.md', content: 'must not persist', entity_type: 'document', revision: 1 },
    };
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [first] }).accepted, 1);
    assert.equal(db.prepare("SELECT content FROM documents WHERE logical_path = 'private.md'").get().content, '');

    saveObserverPolicy(db, 'project-a', { document_capture: 'full' });
    const second = {
      ...first, event_id: 'policy-d-2',
      payload: { ...first.payload, logical_path: 'allowed.md', content: 'allowed by updated policy' },
    };
    assert.equal(ingestObserverEvents(db, { projectId: 'project-a', events: [second] }).accepted, 1);
    assert.equal(db.prepare("SELECT content FROM documents WHERE logical_path = 'allowed.md'").get().content, 'allowed by updated policy');
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
