import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captureProjectScope,
  concurrentScopeConflicts,
  commandHasUnprovenTarget,
  compareProjectScopes,
  extractToolCommand,
  requestedToolCwd,
  scopeActionForCommand,
  scopeActionsForCommand,
  scopeDecision,
} from '../hooks/project-scope.mjs';
import { bindProjectVault } from '../src/project-vault.mjs';

const HOOK_BIN = join(process.cwd(), 'bin', 'wendkeep.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error?.message || ''}`);
  return String(result.stdout || '').trim();
}

function tempRepo(name = 'repo') {
  const parent = mkdtempSync(join(tmpdir(), 'wk-scope-'));
  const project = join(parent, name);
  git(parent, ['init', project]);
  git(project, ['config', 'user.email', 'test@example.invalid']);
  git(project, ['config', 'user.name', 'WendKeep Test']);
  git(project, ['remote', 'add', 'origin', 'https://user:secret@example.com/acme/repo.git']);
  git(project, ['commit', '--allow-empty', '-m', 'fixture']);
  return { parent, project };
}

test('[req:CLI-SCOPE-1] captura raiz, remoto sanitizado, branch e worktree', () => {
  const { parent, project } = tempRepo();
  try {
    const scope = captureProjectScope({
      input: { cwd: project },
      projectRoot: project,
      projectId: 'project-a',
      provider: 'codex',
      sessionId: 'session-a',
    });
    assert.equal(scope.projectId, 'project-a');
    assert.equal(scope.projectRoot, scope.repoRoot, 'project root e repo root usam a mesma identidade física');
    assert.equal(scope.remote, 'https://example.com/acme/repo.git');
    assert.ok(scope.branch);
    assert.ok(scope.worktree);
    assert.ok(scope.head);
    assert.equal(scope.complete, true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:CODEX-13] extrai comando e diretório das formas Codex sem inventar campo', () => {
  const objectInput = {
    cwd: 'C:/session',
    tool_input: { command: 'git status', workdir: 'C:/repo' },
  };
  assert.equal(extractToolCommand(objectInput), 'git status');
  assert.equal(requestedToolCwd(objectInput), 'C:/repo');
  assert.equal(extractToolCommand({ tool_input: 'git commit -m x' }), 'git commit -m x');
  assert.equal(extractToolCommand({ tool_input: { argv: ['git', 'push'] } }), 'git push');
  assert.equal(requestedToolCwd({ cwd: 'C:/session', tool_input: { command: 'git status' } }), 'C:/session');
  assert.equal(requestedToolCwd({ cwd: 'C:/session', tool_input: { command: 'git status', unknown_dir: 'C:/other' } }), 'C:/session');
});

test('[req:CLI-SCOPE-2] classifica capacidades Git independentemente', () => {
  assert.equal(scopeActionForCommand('git commit -m x'), 'git:commit');
  assert.equal(scopeActionForCommand('git push origin main'), 'git:push');
  assert.equal(scopeActionForCommand('git pull --rebase'), 'git:pull');
  assert.equal(scopeActionForCommand('git merge main'), 'git:merge');
  assert.equal(scopeActionForCommand('git status --short'), null);
  assert.equal(scopeActionForCommand('git reset --hard HEAD'), 'git:destructive');
});

test('[req:CLI-SCOPE-2] publicação e ações compostas não herdam autorização entre si', () => {
  assert.equal(scopeActionForCommand('npm publish --access public'), 'publish');
  assert.equal(scopeActionForCommand('npm run release'), 'publish');
  assert.equal(scopeActionForCommand('gh release create v1.2.3'), 'publish');
  assert.deepEqual(scopeActionsForCommand('git commit -m x && git push origin main'), ['git:commit', 'git:push']);

  const { parent, project } = tempRepo();
  try {
    const expected = captureProjectScope({
      input: { cwd: project }, projectRoot: project, projectId: 'project-a',
      provider: 'codex', sessionId: 'session-a',
    });
    const authorizedCommitOnly = { ...expected, authorizedActions: ['git:commit'] };
    const compound = scopeDecision({
      command: 'git commit -m x && git push origin main',
      input: { session_id: 'session-a', cwd: project, tool_input: { command: 'git commit -m x && git push origin main' } },
      expectedScope: authorizedCommitOnly,
      actualScope: expected,
      host: 'codex',
    });
    assert.equal(compound.permissionDecision, 'deny');
    assert.match(compound.permissionDecisionReason, /git:push|autoriza/i);

    const publish = scopeDecision({
      command: 'npm publish',
      input: { session_id: 'session-a', cwd: project, tool_input: { command: 'npm publish' } },
      expectedScope: authorizedCommitOnly,
      actualScope: expected,
      host: 'codex',
    });
    assert.equal(publish.permissionDecision, 'deny');
    assert.match(publish.permissionDecisionReason, /publish|autoriza/i);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:CLI-SCOPE-1] permite mesma scope e nega raiz Git divergente', () => {
  const first = tempRepo('first');
  const second = tempRepo('second');
  try {
    const expected = captureProjectScope({
      input: { cwd: first.project }, projectRoot: first.project, projectId: 'project-a',
      provider: 'codex', sessionId: 'session-a',
    });
    const same = captureProjectScope({
      input: { cwd: first.project }, projectRoot: first.project, projectId: 'project-a',
      provider: 'codex', sessionId: 'session-a',
    });
    assert.deepEqual(compareProjectScopes(expected, same), { ok: true, mismatches: [] });
    const decision = scopeDecision({
      command: 'git commit -m x',
      input: { session_id: 'session-a', cwd: second.project, tool_input: { command: 'git commit -m x' } },
      expectedScope: expected,
      actualScope: captureProjectScope({
        input: { cwd: second.project }, projectRoot: second.project, projectId: 'project-b',
        provider: 'codex', sessionId: 'session-a',
      }),
      host: 'codex',
    });
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /escopo|repositório|projeto/i);
  } finally {
    rmSync(first.parent, { recursive: true, force: true });
    rmSync(second.parent, { recursive: true, force: true });
  }
});

test('[req:CLI-SCOPE-3] escopo ausente ou capacidade não autorizada falha fechado', () => {
  const { parent, project } = tempRepo();
  try {
    const missing = scopeDecision({
      command: 'git push origin main',
      input: { session_id: 'session-a', cwd: project, tool_input: { command: 'git push origin main' } },
      expectedScope: null,
      actualScope: captureProjectScope({ input: { cwd: project }, projectRoot: project, projectId: 'project-a', provider: 'codex', sessionId: 'session-a' }),
      host: 'codex',
    });
    assert.equal(missing.permissionDecision, 'deny');
    const expected = captureProjectScope({ input: { cwd: project }, projectRoot: project, projectId: 'project-a', provider: 'codex', sessionId: 'session-a' });
    const notAuthorized = scopeDecision({
      command: 'git push origin main',
      input: { session_id: 'session-a', cwd: project, tool_input: { command: 'git push origin main' } },
      expectedScope: { ...expected, authorizedActions: ['git:commit'] },
      actualScope: expected,
      host: 'codex',
    });
    assert.equal(notAuthorized.permissionDecision, 'deny');
    assert.match(notAuthorized.permissionDecisionReason, /push|autoriza/i);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:VAULT-6] sessão concorrente bloqueia mesma raiz/branch e aceita worktree distinto', () => {
  const { parent, project } = tempRepo();
  try {
    const expected = captureProjectScope({ input: { cwd: project }, projectRoot: project, projectId: 'project-a', provider: 'codex', sessionId: 'session-a' });
    const blocker = { status: 'active', project_scope: { ...expected, sessionId: 'session-b' } };
    assert.deepEqual(concurrentScopeConflicts(expected, [['session-a', { status: 'active', project_scope: expected }], ['session-b', blocker]], 'session-a'), [
      { sessionId: 'session-b', reason: 'same-repository-branch' },
    ]);
    const denied = scopeDecision({
      command: 'git commit -m x', expectedScope: expected, actualScope: expected, host: 'codex',
      activeSessions: [['session-a', { status: 'active', project_scope: expected }], ['session-b', blocker]],
      currentSessionId: 'session-a',
    });
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /CONFLICT|worktree|lease/i);
    const distinct = { ...blocker, project_scope: { ...blocker.project_scope, worktree: `${blocker.project_scope.worktree}-other` } };
    assert.deepEqual(concurrentScopeConflicts(expected, [['session-b', distinct]], 'session-a'), []);
    const unknown = scopeDecision({
      command: 'git commit -m x', expectedScope: expected, actualScope: expected, host: 'codex',
      activeSessions: [['session-b', { status: 'active' }]], currentSessionId: 'session-a',
    });
    assert.equal(unknown.permissionDecision, 'deny');
    assert.match(unknown.permissionDecisionReason, /CONFLICT|comprovado/i);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:CLI-SCOPE-3] comando com mudança de diretório não comprovada é negado', () => {
  const { parent, project } = tempRepo();
  try {
    const expected = captureProjectScope({ input: { cwd: project }, projectRoot: project, projectId: 'project-a', provider: 'codex', sessionId: 'session-a' });
    const decision = scopeDecision({
      command: 'cd C:/outro && git commit -m x',
      input: { session_id: 'session-a', cwd: project, tool_input: { command: 'cd C:/outro && git commit -m x' } },
      expectedScope: expected,
      actualScope: expected,
      host: 'codex',
      commandTargetKnown: false,
    });
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /diretório|escopo/i);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('[req:CODEX-11] ferramentas de escrita e MCP não classificados falham fechado', () => {
  const expected = {
    schemaVersion: 1, complete: true, projectId: 'project-a', projectRoot: 'C:/projects/a',
    repoRoot: 'C:/projects/a', remote: 'https://example.com/acme/a.git', branch: 'main',
    worktree: 'C:/projects/a/.git', provider: 'codex', sessionId: 'session-a',
  };
  for (const input of [
    { tool_name: 'apply_patch', tool_input: { patch: '*** Begin Patch' } },
    { tool_name: 'mcp__unknown__mutate', tool_input: { value: 'x' } },
  ]) {
    const decision = scopeDecision({ input, expectedScope: expected, actualScope: expected, host: 'codex' });
    assert.equal(decision, null, `${input.tool_name} com scope válida não precisa ser bloqueado`);
  }
  const missing = scopeDecision({
    input: { tool_name: 'mcp__unknown__mutate', tool_input: { value: 'x' } }, host: 'codex',
  });
  assert.equal(missing.permissionDecision, 'deny');
});

test('[req:CLI-SCOPE-3] -C e --work-tree não passam como alvo implícito', () => {
  assert.equal(commandHasUnprovenTarget('git -C C:/other commit -m x'), true);
  assert.equal(commandHasUnprovenTarget('git --work-tree C:/other status'), true);
  assert.equal(commandHasUnprovenTarget('git status --short'), false);
  assert.equal(commandHasUnprovenTarget('Set-Location C:/other; git commit -m x'), true);
});

test('[req:VAULT-5] SessionStart reserva a scope e PreToolUse nega workdir em outro repositório', () => {
  const first = tempRepo('bound');
  const second = tempRepo('foreign');
  const sessionId = '019f56c7-d594-7460-be9b-d246606e3135';
  try {
    const vault = join(first.project, '.bound-vault');
    bindProjectVault({ projectRoot: first.project, vaultPath: vault });
    const transcript = join(first.project, 'rollout.jsonl');
    writeFileSync(transcript, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, session_id: sessionId, model_provider: 'openai' },
    })}\n`);
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_THREAD_ID;
    const start = spawnSync(process.execPath, [join(process.cwd(), 'hooks', 'session-start.mjs')], {
      cwd: first.project,
      input: JSON.stringify({ cwd: first.project, session_id: sessionId, transcript_path: transcript }),
      env,
      encoding: 'utf8',
    });
    assert.equal(start.status, 0, `${start.stderr}\n${start.stdout}`);
    const registryPath = join(vault, '.brain', 'SESSION_REGISTRY.json');
    assert.ok(existsSync(registryPath), `SessionStart não registrou: stdout=${start.stdout} stderr=${start.stderr}`);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.sessions[sessionId].project_scope.complete, true);
    assert.equal(registry.sessions[sessionId].project_scope.remote, 'https://example.com/acme/repo.git');

    const result = spawnSync(process.execPath, [HOOK_BIN, 'hook', 'change-guard'], {
      cwd: first.project,
      input: JSON.stringify({
        cwd: first.project,
        session_id: sessionId,
        transcript_path: transcript,
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m foreign', workdir: second.project },
      }),
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /MISMATCH|escopo|repositório/i);
  } finally {
    rmSync(first.parent, { recursive: true, force: true });
    rmSync(second.parent, { recursive: true, force: true });
  }
});
