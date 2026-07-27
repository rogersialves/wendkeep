import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInjection } from '../hooks/brain-inject.mjs';
import { buildChangePing } from '../hooks/change-context.mjs';
import { warnDecision } from '../hooks/change-warn.mjs';
import { nagDecision } from '../hooks/change-nag.mjs';
import { guardDecision } from '../hooks/change-guard.mjs';
import { capturePlan } from '../hooks/plan-capture.mjs';
import { setActiveChange } from '../hooks/change-core.mjs';
import { upsertSessionRegistry } from '../hooks/obsidian-common.mjs';
import { resolveHookOperatingProfile } from '../hooks/operating-profile-runtime.mjs';
import { readMemoryLedger } from '../hooks/memory-store.mjs';
import { seedMemoryV2 } from '../src/memory.mjs';
import { bindProjectVault } from '../src/project-vault.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PLAN = `# Plano — ajuste local

## Contexto

Corrigir um detalhe local já especificado.

- [ ] Executar o ajuste
- [ ] Validar o resultado
`;

function makeVault() {
  const vault = mkdtempSync(join(tmpdir(), 'wk-profile-hooks-'));
  mkdirSync(join(vault, '.brain', 'lessons'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'CORE.md'), [
    '# CORE',
    '',
    '## Preferências do Usuário',
    '- OFF_MEMORY_SURVIVES',
    '',
    '## Padrões Ativos',
    '- keep-core',
    '',
    '## Pendências Abertas',
    '- nenhuma',
    '',
  ].join('\n'));
  writeFileSync(join(vault, '.brain', 'lessons', '2026-07-26-off.md'), [
    '---',
    'type: lesson',
    '---',
    '',
    'OFF_LESSON_SURVIVES',
    '',
  ].join('\n'));
  return vault;
}

function makeBoundProject(profile) {
  const root = mkdtempSync(join(tmpdir(), 'wk-profile-runtime-'));
  const project = join(root, 'project');
  const vault = join(project, '.vault');
  mkdirSync(project, { recursive: true });
  bindProjectVault({
    projectRoot: project,
    vaultPath: vault,
    configPatch: { harness: { profile } },
  });
  mkdirSync(join(vault, '.brain', 'lessons'), { recursive: true });
  writeFileSync(join(vault, '.brain', 'CORE.md'), [
    '# CORE',
    '',
    '## Preferências do Usuário',
    '- BOUND_PROFILE_MEMORY',
    '',
    '## Padrões Ativos',
    '- runtime-resolution',
    '',
    '## Pendências Abertas',
    '- nenhuma',
    '',
  ].join('\n'));
  writeFileSync(join(vault, '.brain', 'lessons', '2026-07-26-runtime.md'), '---\ntype: lesson\n---\n\nBOUND_PROFILE_LESSON\n');
  return { root, project, vault };
}

function runHookMain(name, input, { provider = 'claude', cwd = ROOT } = {}) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.OBSIDIAN_NO_AUTO_FINALIZE;
  if (provider === 'claude') env.CLAUDECODE = '1';
  else {
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PROJECT_DIR;
  }
  return spawnSync(process.execPath, [join(ROOT, 'hooks', `${name}.mjs`)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env,
  });
}

function snapshotVaultFiles(vault) {
  const snapshot = [];
  const visit = (dir, relative = '') => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, rel);
      else snapshot.push([rel, readFileSync(absolute).toString('base64')]);
    }
  };
  visit(vault);
  return snapshot;
}

function addOpenChange(vault, slug = 'explicit') {
  const dir = join(vault, '08-Mudanças', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proposta.md'), '# proposta\n');
  writeFileSync(join(dir, 'design.md'), '# design\n');
  writeFileSync(join(dir, 'tarefas.md'), '- [ ] 1.1 tarefa explícita\n');
  setActiveChange(vault, slug);
  return dir;
}

function claudePlanInput(vault, id = 'profile-plan-session') {
  const transcript = join(vault, `${id}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: id, message: { content: 'plan' } })}\n`);
  upsertSessionRegistry(vault, id, {
    status: 'active',
    provider: 'claude',
    session_file: `02-Sessões/${id}.md`,
    transcript_path: transcript,
  });
  return {
    session_id: id,
    transcript_path: transcript,
    tool_input: { plan: PLAN },
    tool_response: { plan: PLAN, planWasEdited: true, isAgent: false },
  };
}

test('[req:OP-4] OFF preserves brain memory and lessons while omitting every Wend Runtime block', () => {
  const vault = makeVault();
  try {
    addOpenChange(vault);
    const out = buildInjection(vault, {}, { profile: 'OFF' });

    assert.match(out, /<brain_memory>/);
    assert.match(out, /OFF_MEMORY_SURVIVES/);
    assert.match(out, /<lessons>[\s\S]*OFF_LESSON_SURVIVES[\s\S]*<\/lessons>/);
    assert.doesNotMatch(out, /<wk_process>/);
    assert.doesNotMatch(out, /<open_changes>/);
    assert.doesNotMatch(out, /<session_change>/);
    assert.doesNotMatch(out, /<wk_skill_gate>/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-5] OFF makes every change/governance hook a no-op', () => {
  const vault = makeVault();
  try {
    addOpenChange(vault);
    const options = { profile: 'OFF' };

    assert.equal(buildChangePing(vault, 'off-session', 'implementar uma correção pequena', '', options), null);
    assert.equal(warnDecision('src/app.mjs', { vaultBase: vault, cwd: vault, sessionId: 'off-session', ...options }), null);
    assert.equal(nagDecision({ session_id: 'off-session' }, vault, options), null);
    assert.equal(guardDecision('wendkeep change archive explicit --force', { vaultBase: vault, env: {}, ...options }), null);
    assert.equal(capturePlan(vault, claudePlanInput(vault), options), null);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-5] FLOW does not demand or create a change when none was opened explicitly', () => {
  const vault = makeVault();
  try {
    const input = claudePlanInput(vault, 'flow-no-change');
    const options = { profile: 'FLOW' };

    assert.equal(buildChangePing(vault, 'flow-no-change', 'implementar uma correção pequena', '', options), null);
    assert.equal(warnDecision('src/app.mjs', { vaultBase: vault, cwd: vault, sessionId: 'flow-no-change', ...options }), null);
    assert.equal(capturePlan(vault, input, options), null);
    assert.equal(existsSync(join(vault, '08-Mudanças')), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-5] FLOW keeps an explicitly opened change protected and profile-scopes sentinels', () => {
  const vault = makeVault();
  try {
    addOpenChange(vault);
    const input = claudePlanInput(vault, 'flow-explicit');

    const governPing = buildChangePing(vault, 'same-session', 'continuar implementação', 'explicit', { profile: 'GOVERN' });
    const flowPing = buildChangePing(vault, 'same-session', 'continuar implementação', 'explicit', { profile: 'FLOW' });
    assert.match(governPing?.context || '', /open_changes_ping/);
    assert.match(flowPing?.context || '', /open_changes_ping/);

    const sentinels = readdirSync(join(vault, '.brain')).filter((name) => name.startsWith('.change-ctx-'));
    assert.equal(sentinels.length, 2);
    assert.ok(sentinels.some((name) => /govern/i.test(name)), sentinels.join(', '));
    assert.ok(sentinels.some((name) => /flow/i.test(name)), sentinels.join(', '));

    const nag = nagDecision({ session_id: 'flow-explicit' }, vault, { profile: 'FLOW' });
    assert.equal(nag?.decision, 'block');
    const guard = guardDecision('git commit --no-verify -m x', { vaultBase: vault, env: {}, profile: 'FLOW' });
    assert.equal(guard?.permissionDecision, 'ask');

    const capture = capturePlan(vault, input, { profile: 'FLOW' });
    assert.equal(capture?.slug, 'explicit');
    assert.equal(capture?.created, false);
    assert.equal(readdirSync(join(vault, '08-Mudanças')).length, 1);
    assert.match(readFileSync(join(vault, '08-Mudanças', 'explicit', 'plano-aprovado.md'), 'utf8'), /planos\//);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('[req:OP-2] hook runtime resolves session override before project binding and fails safe to GOVERN', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    upsertSessionRegistry(fixture.vault, 'runtime-session', {
      status: 'active',
      provider: 'claude',
      operating_profile: 'OFF',
    });
    const off = resolveHookOperatingProfile({
      input: { cwd: fixture.project, session_id: 'runtime-session' },
      provider: 'claude',
    });
    assert.equal(off.profile, 'OFF');
    assert.equal(off.source, 'session-override');

    upsertSessionRegistry(fixture.vault, 'runtime-session', { operating_profile: 'TURBO' });
    const invalid = resolveHookOperatingProfile({
      input: { cwd: fixture.project, session_id: 'runtime-session' },
      provider: 'claude',
    });
    assert.equal(invalid.profile, 'GOVERN');
    assert.equal(invalid.source, 'session-override-invalid');
    assert.equal(invalid.valid, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] explicit hook vault preserves the matching project binding profile', () => {
  const fixture = makeBoundProject('OFF');
  try {
    addOpenChange(fixture.vault);
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'explicit-vault-profile',
    };

    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'OFF');
    assert.equal(resolved.source, 'project-binding');

    const run = runHookMain('brain-inject', input);
    assert.equal(run.status, 0, run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /BOUND_PROFILE_MEMORY/);
    assert.doesNotMatch(context, /<wk_process>|<open_changes>|<session_change>|<wk_skill_gate>/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] [req:OP-4] corrupt binding with explicit vault preserves audited session OFF, Keep Core and fail-closed guard', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    upsertSessionRegistry(fixture.vault, 'corrupt-explicit-binding', {
      status: 'active',
      provider: 'claude',
      operating_profile: 'OFF',
    });
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'corrupt-explicit-binding',
    };

    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'OFF');
    assert.equal(resolved.source, 'session-override');
    assert.equal(resolved.policy.harness, false);
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');

    const inject = runHookMain('brain-inject', input);
    assert.equal(inject.status, 0, inject.stderr);
    const context = JSON.parse(inject.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /BOUND_PROFILE_MEMORY/);
    assert.match(context, /BOUND_PROFILE_LESSON/);
    assert.doesNotMatch(context, /<wk_process>/);
    assert.match(context, /WENDKEEP_VAULT_CONFIG_INVALID/);

    const guard = runHookMain('change-guard', {
      ...input,
      tool_input: { command: 'git commit -m corrupt-binding' },
    });
    assert.equal(guard.status, 0, guard.stderr);
    const decision = JSON.parse(guard.stdout).hookSpecificOutput;
    assert.equal(decision?.permissionDecision, 'deny');
    assert.match(decision?.permissionDecisionReason || '', /WENDKEEP_VAULT_CONFIG_INVALID/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] corrupt binding keeps brain injection read-only while preserving Keep Core and diagnosis', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    addOpenChange(fixture.vault);
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'corrupt-govern-brain',
    };
    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'GOVERN');
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');

    const before = snapshotVaultFiles(fixture.vault);
    const run = runHookMain('brain-inject', input);
    assert.equal(run.status, 0, run.stderr);
    const context = JSON.parse(run.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /BOUND_PROFILE_MEMORY/);
    assert.match(context, /WENDKEEP_VAULT_CONFIG_INVALID/);
    assert.deepEqual(snapshotVaultFiles(fixture.vault), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] corrupt binding keeps change-context read-only and exposes the diagnosis', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    addOpenChange(fixture.vault);
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'corrupt-govern-context',
      prompt: 'implementar uma correção pequena e validar o resultado',
    };
    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'GOVERN');
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');

    const before = snapshotVaultFiles(fixture.vault);
    const run = runHookMain('change-context', input);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /WENDKEEP_VAULT_CONFIG_INVALID/);
    assert.deepEqual(snapshotVaultFiles(fixture.vault), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] corrupt binding keeps change-nag read-only and blocks with the diagnosis', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    addOpenChange(fixture.vault);
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'corrupt-govern-nag',
    };
    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'GOVERN');
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');

    const before = snapshotVaultFiles(fixture.vault);
    const run = runHookMain('change-nag', input);
    assert.equal(run.status, 0, run.stderr);
    const decision = JSON.parse(run.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason || '', /WENDKEEP_VAULT_CONFIG_INVALID/);
    assert.deepEqual(snapshotVaultFiles(fixture.vault), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] corrupt binding keeps change-warn read-only and exposes the diagnosis', () => {
  const fixture = makeBoundProject('FLOW');
  try {
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    const input = {
      cwd: fixture.project,
      obsidian_vault_path: fixture.vault,
      session_id: 'corrupt-govern-warn',
      tool_input: { file_path: 'src/app.mjs' },
    };
    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'GOVERN');
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');

    const before = snapshotVaultFiles(fixture.vault);
    const run = runHookMain('change-warn', input);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /WENDKEEP_VAULT_CONFIG_INVALID/);
    assert.deepEqual(snapshotVaultFiles(fixture.vault), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] [req:OP-4] corrupt binding with legacy vault preserves audited session OFF and exposes the diagnosis', () => {
  const fixture = makeBoundProject('OFF');
  try {
    upsertSessionRegistry(fixture.vault, 'corrupt-legacy-binding', {
      status: 'active',
      provider: 'claude',
      operating_profile: 'OFF',
    });
    writeFileSync(join(fixture.project, '.wendkeep.json'), '{ invalid json');
    mkdirSync(join(fixture.project, '.claude'), { recursive: true });
    writeFileSync(join(fixture.project, '.claude', 'settings.json'), `${JSON.stringify({
      env: { OBSIDIAN_VAULT_PATH: fixture.vault },
    }, null, 2)}\n`);
    const input = { cwd: fixture.project, session_id: 'corrupt-legacy-binding' };

    const resolved = resolveHookOperatingProfile({ input, provider: 'claude' });
    assert.equal(resolved.profile, 'OFF');
    assert.equal(resolved.source, 'session-override');
    assert.equal(resolved.policy.harness, false);
    assert.equal(resolved.bindingError?.code, 'WENDKEEP_VAULT_CONFIG_INVALID');
    assert.equal(resolved.resolution.source, 'legacy-project-settings');

    const inject = runHookMain('brain-inject', input);
    assert.equal(inject.status, 0, inject.stderr);
    const context = JSON.parse(inject.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /BOUND_PROFILE_MEMORY/);
    assert.match(context, /BOUND_PROFILE_LESSON/);
    assert.doesNotMatch(context, /<wk_process>/);
    assert.match(context, /WENDKEEP_VAULT_CONFIG_INVALID/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-2] corrupt binding without an authoritative vault is visible and mutating guards fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'wk-corrupt-unresolved-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.wendkeep.json'), '{ invalid json');
  const input = { cwd: project, session_id: 'corrupt-unresolved-binding' };
  try {
    const inject = runHookMain('brain-inject', input);
    assert.equal(inject.status, 0, inject.stderr);
    const context = JSON.parse(inject.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /WENDKEEP_VAULT_CONFIG_INVALID/);

    const guard = runHookMain('change-guard', {
      ...input,
      tool_input: { command: 'git commit -m corrupt-binding' },
    });
    assert.equal(guard.status, 0, guard.stderr);
    const decision = JSON.parse(guard.stdout).hookSpecificOutput;
    assert.equal(decision?.permissionDecision, 'deny');
    assert.match(decision?.permissionDecisionReason || '', /WENDKEEP_VAULT_CONFIG_INVALID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('[req:OP-2] change-guard nega binding com marcador ausente ou de outro projeto', () => {
  const fixture = makeBoundProject('GOVERN');
  const markerPath = join(fixture.vault, '.brain', 'PROJECT.json');
  const input = {
    cwd: fixture.project,
    session_id: 'marker-integrity-guard',
    tool_input: { command: 'git commit -m marker-integrity' },
  };
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    writeFileSync(markerPath, `${JSON.stringify({ ...marker, projectId: 'outro-projeto' }, null, 2)}\n`);
    const mismatch = runHookMain('change-guard', input);
    assert.equal(mismatch.status, 0, mismatch.stderr);
    const mismatchDecision = JSON.parse(mismatch.stdout).hookSpecificOutput;
    assert.equal(mismatchDecision?.permissionDecision, 'deny');
    assert.match(mismatchDecision?.permissionDecisionReason || '', /WENDKEEP_VAULT_PROJECT_MISMATCH/);

    rmSync(markerPath, { force: true });
    const missing = runHookMain('change-guard', input);
    assert.equal(missing.status, 0, missing.stderr);
    const missingDecision = JSON.parse(missing.stdout).hookSpecificOutput;
    assert.equal(missingDecision?.permissionDecision, 'deny');
    assert.match(missingDecision?.permissionDecisionReason || '', /WENDKEEP_VAULT_MARKER_MISSING/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-4] hook entrypoint reads project OFF and live session GOVERN override', () => {
  const fixture = makeBoundProject('OFF');
  try {
    addOpenChange(fixture.vault);
    const input = { cwd: fixture.project, session_id: 'entrypoint-profile' };

    const offRun = runHookMain('brain-inject', input);
    assert.equal(offRun.status, 0, offRun.stderr);
    const offContext = JSON.parse(offRun.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(offContext, /BOUND_PROFILE_MEMORY/);
    assert.match(offContext, /BOUND_PROFILE_LESSON/);
    assert.doesNotMatch(offContext, /<wk_process>|<open_changes>|<session_change>|<wk_skill_gate>/);

    upsertSessionRegistry(fixture.vault, 'entrypoint-profile', {
      status: 'active',
      provider: 'claude',
      operating_profile: 'GOVERN',
    });
    const governRun = runHookMain('brain-inject', input);
    assert.equal(governRun.status, 0, governRun.stderr);
    const governContext = JSON.parse(governRun.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(governContext, /<wk_process>/);
    assert.match(governContext, /<open_changes>/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('[req:OP-4] [sensor:tests] OFF keeps SessionStart/Stop note, registry and memory lifecycle alive', () => {
  const fixture = makeBoundProject('OFF');
  const sessionId = 'off-core-session';
  const transcript = join(fixture.project, 'off-core-rollout.jsonl');
  const corePath = join(fixture.vault, '.brain', 'CORE.md');
  const registryPath = join(fixture.vault, '.brain', 'SESSION_REGISTRY.json');
  try {
    seedMemoryV2(fixture.vault);
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'off-core-rollout',
        session_id: sessionId,
        model_provider: 'openai',
        cwd: fixture.project,
      },
    })}\n`);
    const coreBefore = readFileSync(corePath, 'utf8');
    const baseInput = { cwd: fixture.project, session_id: sessionId, transcript_path: transcript };

    const start = runHookMain('session-start', {
      ...baseInput,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, { provider: 'codex', cwd: fixture.project });
    assert.equal(start.status, 0, start.stderr);
    assert.match(JSON.parse(start.stdout).hookSpecificOutput?.additionalContext || '', /<obsidian_session>/);

    const afterStart = JSON.parse(readFileSync(registryPath, 'utf8'));
    const sessionRel = afterStart.sessions?.[sessionId]?.session_file;
    assert.ok(sessionRel, JSON.stringify(afterStart));
    const sessionPath = join(fixture.vault, sessionRel);
    assert.equal(existsSync(sessionPath), true);

    const turnId = 'off-core-turn-1';
    for (const event of [
      { type: 'turn_context', payload: { turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Preserve the Keep Core in OFF.' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'OFF lifecycle evidence recorded.' } },
    ]) appendFileSync(transcript, `${JSON.stringify(event)}\n`);

    const stop = runHookMain('session-stop', {
      ...baseInput,
      hook_event_name: 'Stop',
      turn_id: turnId,
    }, { provider: 'codex', cwd: fixture.project });
    assert.equal(stop.status, 0, stop.stderr);
    assert.doesNotThrow(() => JSON.parse(stop.stdout || '{}'));

    const note = readFileSync(sessionPath, 'utf8');
    assert.match(note, /Preserve the Keep Core in OFF/);
    assert.match(note, /OFF lifecycle evidence recorded/);
    const afterStop = JSON.parse(readFileSync(registryPath, 'utf8'));
    const stoppedSession = afterStop.sessions?.[sessionId];
    assert.equal(stoppedSession?.session_file, sessionRel);
    assert.equal(stoppedSession?.memory_status, 'projected');
    assert.equal(stoppedSession?.last_memory_attempt?.memory_mode, 'v2');
    assert.equal(stoppedSession?.last_memory_attempt?.state, 'projected');
    assert.ok(stoppedSession?.last_memory_attempt?.event_ids?.length > 0, JSON.stringify(stoppedSession));
    assert.deepEqual(stoppedSession?.last_memory_attempt?.checkpoint, stoppedSession?.memory_checkpoint);
    assert.match(stoppedSession?.memory_checkpoint?.state_hash || '', /^[a-f0-9]{64}$/);

    const ledger = readMemoryLedger(fixture.vault);
    assert.equal(ledger.status, 'ok');
    assert.deepEqual(
      ledger.events.map((event) => event.event_id),
      stoppedSession.last_memory_attempt.event_ids,
    );
    assert.equal(stoppedSession.memory_checkpoint.event_cursor, ledger.events.at(-1)?.event_id);
    assert.equal(readFileSync(corePath, 'utf8'), coreBefore);

    const inject = runHookMain('brain-inject', baseInput, { provider: 'codex', cwd: fixture.project });
    assert.equal(inject.status, 0, inject.stderr);
    const context = JSON.parse(inject.stdout).hookSpecificOutput?.additionalContext || '';
    assert.match(context, /BOUND_PROFILE_MEMORY/);
    assert.match(context, /BOUND_PROFILE_LESSON/);
    assert.doesNotMatch(context, /<wk_process>|<open_changes>|<session_change>|<wk_skill_gate>/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
