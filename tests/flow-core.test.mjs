import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { finishFlow, flowStatus, isProtectedFlowPath, promoteFlow, resolveFlowSession, startFlow } from '../hooks/flow-core.mjs';
import { readFlow } from '../hooks/vault-runtime-store.mjs';
import { copyGitFixture, git } from './helpers/git-fixture.mjs';

function fixture({ sensorStatus = 0, sensorCommand = '', twoSessions = false } = {}) {
  const key = `flow-core-${JSON.stringify({ sensorStatus, sensorCommand, twoSessions })}`;
  const root = copyGitFixture(key, (templateRoot) => {
    const vault = join(templateRoot, '.vault');
    const sessionRel = ['02-Sessões', '2026', '07-JUL', 'DIA 26', 'flow.md'].join('/');
    const sessionPath = join(vault, ...sessionRel.split('/'));
    mkdirSync(join(templateRoot, 'src'), { recursive: true });
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(join(sessionPath, '..'), { recursive: true });
    writeFileSync(join(templateRoot, 'src', 'app.mjs'), 'export const value = 1;\n');
    writeFileSync(join(templateRoot, 'other.txt'), 'base\n');
    writeFileSync(join(templateRoot, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(templateRoot, '.gitignore'), '.vault/\n');
    writeFileSync(join(templateRoot, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{
        id: 'focused',
        severity: 'critical',
        command: sensorCommand || `node -e "process.exit(${sensorStatus})"`,
      }],
    }));
    writeFileSync(sessionPath, `---
type: session
session_id: session-1
status: active
---

# FLOW

## Iterações

## Decisões geradas nesta sessão

## Encerramento
`);
    const sessions = {
      'session-1': { status: 'active', provider: 'codex', session_file: sessionRel, started_at: '2026-07-26T10:00:00.000Z' },
    };
    if (twoSessions) sessions['session-2'] = { status: 'active', provider: 'claude', session_file: '02-Sessões/other.md' };
    writeSessionRegistry(vault, { version: 2, sessions });
    git(templateRoot, 'add', '.');
    git(templateRoot, 'commit', '-qm', 'base');
  }, { prefix: 'wk-flow-core' });
  const vault = join(root, '.vault');
  const sessionRel = ['02-Sessões', '2026', '07-JUL', 'DIA 26', 'flow.md'].join('/');
  const sessionPath = join(vault, ...sessionRel.split('/'));
  return { root, vault, sessionRel, sessionPath };
}

function startArgs(fx, overrides = {}) {
  return {
    vaultBase: fx.vault,
    projectRoot: fx.root,
    projectId: 'project-1',
    slug: 'tiny-fix',
    allowedPaths: ['src/app.mjs'],
    sensorIds: ['focused'],
    reason: 'ajuste localizado sem contrato público',
    sessionId: 'session-1',
    now: new Date('2026-07-26T12:00:00.000Z'),
    ...overrides,
  };
}

test('[req:OP-6] sessão implícita precisa ser inequívoca', () => {
  const fx = fixture({ twoSessions: true });
  try {
    assert.throws(() => resolveFlowSession(fx.vault, { env: {} }), /ambígua|mais de uma/i);
    assert.equal(resolveFlowSession(fx.vault, { sessionId: 'session-1', env: {} }).sessionId, 'session-1');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-6] flow start exige allowlist e sensor e não cria change/ADR/CURRENT_CHANGE', () => {
  const fx = fixture();
  try {
    assert.throws(() => startFlow(startArgs(fx, { allowedPaths: [] })), /allowlist|path permitido/i);
    assert.throws(() => startFlow(startArgs(fx, { sensorIds: [] })), /sensor/i);
    const started = startFlow(startArgs(fx));
    assert.equal(started.state, 'active');
    assert.deepEqual(started.contract.allowed_paths, ['src/app.mjs']);
    assert.deepEqual(started.contract.sensor_ids, ['focused']);
    assert.equal(existsSync(join(fx.vault, '08-Mudanças')), false);
    assert.equal(existsSync(join(fx.vault, '.brain', 'CURRENT_CHANGE.md')), false);
    assert.equal(flowStatus(fx.vault, { flowId: started.contract.flow_id }).state, 'active');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish verde grava recibo terminal e projeta uma única iteração', () => {
  const fx = fixture();
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const finished = finishFlow({
      vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id,
      now: new Date('2026-07-26T12:05:00.000Z'),
    });
    assert.equal(finished.ok, true, JSON.stringify(finished.failures || []));
    assert.equal(finished.state.state, 'finished');
    assert.deepEqual(finished.state.receipt.changed_paths, ['src/app.mjs']);
    assert.equal(finished.state.receipt.evidence[0].status, 'green');
    const projected = readFileSync(fx.sessionPath, 'utf8');
    assert.equal((projected.match(/wk-turn: flow:.*:finished/g) || []).length, 1);
    finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal((readFileSync(fx.sessionPath, 'utf8').match(/wk-turn: flow:.*:finished/g) || []).length, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-10] flow finish executa sensores contra o Vault efetivo, não o ambiente herdado', () => {
  const sensorCommand = `node -e "const { existsSync } = require('node:fs'); const { join } = require('node:path'); process.exit(existsSync(join(process.env.OBSIDIAN_VAULT_PATH || '', '.brain', 'SESSION_REGISTRY.json')) ? 0 : 1)"`;
  const fx = fixture({ sensorCommand });
  const decoyVault = mkdtempSync(join(tmpdir(), 'wk-flow-decoy-vault-'));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  try {
    process.env.OBSIDIAN_VAULT_PATH = decoyVault;
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 9;\n');

    const finished = finishFlow({
      vaultBase: fx.vault,
      projectRoot: fx.root,
      flowId: started.contract.flow_id,
      now: new Date('2026-07-26T12:06:00.000Z'),
    });

    assert.equal(finished.ok, true, JSON.stringify(finished.failures || []));
    assert.equal(finished.state.receipt.evidence[0].status, 'green');
  } finally {
    if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previousVault;
    rmSync(decoyVault, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish não terminaliza quando a nota de sessão não pode receber a projeção', () => {
  const fx = fixture();
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 6;\n');
    unlinkSync(fx.sessionPath);

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /sessão.*projeção|nota.*sessão/i);
    const state = readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id });
    assert.equal(state.state, 'active');
    assert.equal(state.receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] lock da sessão nunca produz sucesso silencioso e retry projeta uma vez', () => {
  const fx = fixture();
  const lock = `${fx.sessionPath}.lock`;
  const lockToken = `flow-core-live-${process.pid}`;
  const lockOwner = join(lock, '.owner.json');
  const lockLease = join(lock, `.lease-${lockToken}`);
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 7;\n');
    mkdirSync(lock);
    writeFileSync(lockOwner, `${JSON.stringify({
      v: 1,
      pid: process.pid,
      token: lockToken,
      created_at: new Date().toISOString(),
    })}\n`);
    writeFileSync(lockLease, `${lockToken}\n`);

    const blocked = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(blocked.ok, false);
    assert.match(blocked.failures.join('\n'), /projeção.*busy/i);
    assert.equal(blocked.state.state, 'finished');
    assert.equal(blocked.state.receipt.status, 'finished');

    unlinkSync(lockLease);
    unlinkSync(lockOwner);
    rmdirSync(lock);
    const retried = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(retried.ok, true);
    assert.equal(retried.idempotent, true);
    assert.equal((readFileSync(fx.sessionPath, 'utf8').match(/wk-turn: flow:.*:finished/g) || []).length, 1);
  } finally {
    rmSync(lock, { recursive: true, force: true });
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish bloqueia path fora da allowlist sem gravar recibo', () => {
  const fx = fixture();
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'other.txt'), 'alterado\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /fora da allowlist.*other\.txt/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish revalida a topologia física da allowlist contra troca por junction', () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  try {
    mkdirSync(join(fx.root, 'linked'), { recursive: true });
    writeFileSync(join(fx.root, 'linked', 'x.txt'), 'base\n');
    git(fx.root, 'add', 'linked/x.txt');
    git(fx.root, 'commit', '-qm', 'add allowed directory');
    const started = startFlow(startArgs(fx, { allowedPaths: ['linked/**'] }));

    rmSync(join(fx.root, 'linked'), { recursive: true, force: true });
    symlinkSync(outside, join(fx.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(outside, 'x.txt'), 'outside changed\n');

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /link simbólico|reparse|raiz física/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish bloqueia superfície protegida mesmo presente na allowlist', () => {
  const fx = fixture();
  try {
    for (const protectedPath of [
      'package.json',
      'deno.json',
      'deno.lock',
      'pyproject.toml',
      'prisma/schema.prisma',
      'src/auth-client.ts',
      'src/oauth/callback.ts',
      'src/acl.ts',
      'src/access-control.ts',
      'src/policy.ts',
      'src/api/routes/users.ts',
      'src/login.ts',
      'src/jwt.ts',
      'src/crypto.ts',
      'src/public-api.ts',
      'src/authService.ts',
      'src/loginHandler.ts',
      'src/tokenManager.ts',
      'src/jwtVerifier.ts',
      'src/securityPolicy.ts',
      'src/api.ts',
      'src/authz.ts',
      'src/authn.ts',
      'src/policyEngine.ts',
      'src/permissionService.ts',
      'src/roleManager.ts',
      'src/rbacMiddleware.ts',
      'src/credentialStore.ts',
      'src/secretManager.ts',
      'src/routeHandler.ts',
      'src/endpointRegistry.ts',
      'db/migrate/20260726.sql',
      'alembic/versions/001.py',
      '.travis.yml',
      'appveyor.yml',
      'cloudbuild.yaml',
      'buildspec.yml',
      '.env',
      '.env.production',
      '.gitignore',
      '.gitmodules',
      '.npmrc',
      '.yarnrc.yml',
      'pnpm-workspace.yaml',
      '.pypirc',
      '.mcp.json',
      '.claude/settings.json',
      '.codex/hooks.json',
      '.codex/config.toml',
      '.agent/hooks/session-start.mjs',
      'config/secrets.json',
      'api/service.proto',
      'schema/public.graphql',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
      'Dockerfile',
      'scripts/release.mjs',
      'CHANGELOG.md',
      'wendkeep.sensors.json',
      'hooks/sensors-core.mjs',
      'hooks/brain-inject.mjs',
      'hooks/memory-store.mjs',
      'src/flow.mjs',
      'src/memory.mjs',
      'src/init.mjs',
      'src/sync.mjs',
      'src/sync-defs.mjs',
      'src/skills-seed.mjs',
      'src/spec.mjs',
      'src/validate-memory.mjs',
      'src/validate-core.mjs',
      'packages/app/AGENTS.md',
    ]) assert.equal(isProtectedFlowPath(protectedPath), true, protectedPath);
    assert.equal(isProtectedFlowPath('src/author-card.ts'), false);
    assert.equal(isProtectedFlowPath('src/apicalChart.ts'), false);
    assert.equal(isProtectedFlowPath('src/apiary.ts'), false);
    const started = startFlow(startArgs(fx, { allowedPaths: ['package.json'] }));
    writeFileSync(join(fx.root, 'package.json'), '{"name":"changed"}\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /protegida.*package\.json/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] raízes protegidas adicionais vêm do binding e ficam no contrato FLOW', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'src', 'internal-api'), { recursive: true });
    writeFileSync(join(fx.root, 'src', 'internal-api', 'value.ts'), 'export const value = 1;\n');
    writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-1',
      vault: '.vault',
      harness: { flow: { protectedRoots: ['src/internal-api'] } },
    }, null, 2));
    git(fx.root, 'add', '.');
    git(fx.root, 'commit', '-qm', 'add project binding and protected root');

    const started = startFlow(startArgs(fx, { allowedPaths: ['src/**'] }));
    assert.deepEqual(started.contract.protected_roots, ['src/internal-api/**']);
    writeFileSync(join(fx.root, 'src', 'internal-api', 'value.ts'), 'export const value = 2;\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /superfície protegida.*src\/internal-api\/value\.ts/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] start rejeita raiz protegida vazia redirecionada por junction', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-protected-outside-'));
  try {
    writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
      version: 1,
      harness: { flow: { protectedRoots: ['private'] } },
    }, null, 2));
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nprivate/\n');
    git(fx.root, 'add', '.wendkeep.json', '.gitignore');
    git(fx.root, 'commit', '-qm', 'configure empty protected root');
    try {
      symlinkSync(outside, join(fx.root, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => startFlow(startArgs(fx)), /protegida|link simbólico|reparse|topologia/i);
    assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] start rejeita raiz protegida dangling antes de criar contrato', (t) => {
  const fx = fixture();
  const missing = join(tmpdir(), `wk-flow-protected-missing-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
      version: 1,
      harness: { flow: { protectedRoots: ['private'] } },
    }, null, 2));
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nprivate/\n');
    git(fx.root, 'add', '.wendkeep.json', '.gitignore');
    git(fx.root, 'commit', '-qm', 'configure dangling protected root');
    try {
      symlinkSync(missing, join(fx.root, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => startFlow(startArgs(fx)), /protegida|link simbólico|reparse|topologia/i);
    assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] start rejeita diretório protegido built-in vazio redirecionado', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-builtin-outside-'));
  try {
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\n.github/\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore builtin protected root');
    try {
      symlinkSync(outside, join(fx.root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => startFlow(startArgs(fx)), /link simbólico|reparse|topologia/i);
    assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] start inspeciona descendentes físicos de raiz built-in protegida', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-builtin-child-'));
  try {
    mkdirSync(join(fx.root, '.github'), { recursive: true });
    try {
      symlinkSync(outside, join(fx.root, '.github', 'workflows'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(() => startFlow(startArgs(fx)), /link simbólico|reparse|topologia/i);
    assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] start rejeita alias semântico ignorado e vazio com allowlist exata', async (t) => {
  for (const protectedName of ['auth', 'schema']) {
    await t.test(protectedName, (subtest) => {
      const fx = fixture();
      const outside = mkdtempSync(join(tmpdir(), `wk-flow-semantic-${protectedName}-`));
      try {
        writeFileSync(join(fx.root, '.gitignore'), `.vault/\nsrc/${protectedName}/\n`);
        git(fx.root, 'add', '.gitignore');
        git(fx.root, 'commit', '-qm', `ignore empty ${protectedName}`);
        try {
          symlinkSync(outside, join(fx.root, 'src', protectedName), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
            subtest.skip(`links indisponíveis neste filesystem: ${error.code}`);
            return;
          }
          throw error;
        }

        assert.throws(
          () => startFlow(startArgs(fx, { allowedPaths: ['src/app.mjs'] })),
          new RegExp(`${protectedName}.*(?:link simbólico|junction|reparse)|(?:link simbólico|junction|reparse).*${protectedName}`, 'i'),
        );
        assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});

test('[req:OP-7] finish detecta alias protegido ignorado fora do allowlist antes dos sensores', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-semantic-finish-'));
  try {
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nsrc/auth/\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore semantic protected alias');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/app.mjs'] }));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    try {
      symlinkSync(outside, join(fx.root, 'src', 'auth'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /src\/auth.*(?:link simbólico|junction|reparse)|(?:link simbólico|junction|reparse).*src\/auth/i);
    assert.deepEqual(result.state.attempts.at(-1).evidence, []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] promoção revalida scan físico protegido antes de reservar a change', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-semantic-promote-'));
  try {
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nsrc/schema/\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore schema alias');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/app.mjs'] }));
    try {
      symlinkSync(outside, join(fx.root, 'src', 'schema'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => promoteFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id }),
      /src\/schema|scan físico protegido|link simbólico|junction|reparse/i,
    );
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).state, 'active');
    assert.equal(existsSync(join(fx.vault, '08-Mudanças')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish detecta alteração em raiz protegida mesmo quando ignorada pelo Git', () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, 'private'), { recursive: true });
    writeFileSync(join(fx.root, 'private', 'data.txt'), 'before\n');
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nprivate/\n');
    writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-1',
      vault: '.vault',
      harness: { flow: { protectedRoots: ['private'] } },
    }, null, 2));
    git(fx.root, 'add', '.gitignore', '.wendkeep.json');
    git(fx.root, 'commit', '-qm', 'configure ignored protected root');

    const started = startFlow(startArgs(fx, { allowedPaths: ['src/**', 'private/**'] }));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    writeFileSync(join(fx.root, 'private', 'data.txt'), 'after\n');

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /superfície protegida.*private\/data\.txt/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] raiz protegida dentro de submodule mantém paths internos atribuíveis', () => {
  const fx = fixture();
  const source = mkdtempSync(join(tmpdir(), 'wk-flow-protected-submodule-'));
  try {
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'flow@example.invalid');
    git(source, 'config', 'user.name', 'FLOW Test');
    writeFileSync(join(source, '.gitignore'), 'private/\n');
    writeFileSync(join(source, 'lib.txt'), 'base\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'submodule baseline');
    git(fx.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'plugins/ext');
    writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
      version: 1,
      harness: { flow: { protectedRoots: ['plugins/ext/private'] } },
    }, null, 2));
    git(fx.root, 'add', '.gitmodules', 'plugins/ext', '.wendkeep.json');
    git(fx.root, 'commit', '-qm', 'configure protected submodule root');
    const protectedFile = join(fx.root, 'plugins', 'ext', 'private', 'data.txt');
    mkdirSync(join(protectedFile, '..'), { recursive: true });
    writeFileSync(protectedFile, 'before\n');

    const started = startFlow(startArgs(fx, { allowedPaths: ['src/app.mjs', 'plugins/ext/**'] }));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 13;\n');
    writeFileSync(protectedFile, 'after\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /superfície protegida.*plugins\/ext\/private\/data\.txt/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test('[req:OP-7] projeto aninhado protege seu binding usando paths relativos à raiz Git', () => {
  const fx = fixture();
  try {
    const projectRoot = join(fx.root, 'packages', 'app');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'app.mjs'), 'export const nested = 1;\n');
    writeFileSync(join(projectRoot, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{ id: 'focused', severity: 'critical', command: 'node -e "process.exit(0)"' }],
    }));
    const binding = {
      schemaVersion: 1,
      projectId: 'nested-project',
      vault: '../../.vault',
      harness: { profile: 'FLOW' },
    };
    writeFileSync(join(projectRoot, '.wendkeep.json'), JSON.stringify(binding, null, 2));
    git(fx.root, 'add', 'packages/app');
    git(fx.root, 'commit', '-qm', 'add nested project');

    const started = startFlow(startArgs(fx, {
      projectRoot,
      projectId: 'nested-project',
      allowedPaths: ['.wendkeep.json'],
    }));
    writeFileSync(join(projectRoot, '.wendkeep.json'), JSON.stringify({
      ...binding,
      harness: { profile: 'OFF' },
    }, null, 2));

    const result = finishFlow({ vaultBase: fx.vault, projectRoot, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /superfície protegida.*packages\/app\/\.wendkeep\.json/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] projeto aninhado congela projectRoot e executa sensor nesse cwd', () => {
  const fx = fixture();
  try {
    const projectRoot = join(fx.root, 'packages', 'app');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'app.mjs'), 'export const nested = 1;\n');
    writeFileSync(join(projectRoot, 'cwd.marker'), 'nested project\n');
    writeFileSync(join(projectRoot, 'wendkeep.sensors.json'), JSON.stringify({
      version: 1,
      sensors: [{
        id: 'focused',
        severity: 'critical',
        command: 'node -e "const fs=require(\'fs\');process.exit(fs.existsSync(\'cwd.marker\')?0:7)"',
      }],
    }));
    git(fx.root, 'add', 'packages/app');
    git(fx.root, 'commit', '-qm', 'add nested sensor project');

    const started = startFlow(startArgs(fx, {
      projectRoot,
      projectId: 'nested-project',
      allowedPaths: ['src/app.mjs'],
    }));
    assert.equal(started.contract.project_rel, 'packages/app');
    writeFileSync(join(projectRoot, 'src', 'app.mjs'), 'export const nested = 2;\n');

    const swapped = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(swapped.ok, false);
    assert.match(swapped.failures.join('\n'), /projectRoot|projeto congelado|repositório/i);

    const finished = finishFlow({ vaultBase: fx.vault, projectRoot, flowId: started.contract.flow_id });
    assert.equal(finished.ok, true, finished.failures?.join('\n'));
    assert.equal(finished.state.receipt.evidence[0].status, 'green');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] binding rejeita raízes protegidas absolutas, traversal, glob e sobreposição', () => {
  const invalidRoots = [
    [join(tmpdir(), 'absolute-root')],
    ['../outside'],
    ['src/../private'],
    ['src/*/private'],
    ['src', 'src/private'],
    [42],
  ];
  for (const protectedRoots of invalidRoots) {
    const fx = fixture();
    try {
      writeFileSync(join(fx.root, '.wendkeep.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'project-1',
        vault: '.vault',
        harness: { flow: { protectedRoots } },
      }));
      assert.throws(
        () => startFlow(startArgs(fx, { allowedPaths: ['src/**'] })),
        /raiz protegida|protectedRoots|sobrepos/i,
        protectedRoots.join(', '),
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('[req:OP-7] finish bloqueia junction criada dentro de raiz allowlisted antes dos sensores', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  try {
    writeFileSync(join(outside, 'x.txt'), 'outside\n');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/**'] }));
    try {
      symlinkSync(outside, join(fx.root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /link simbólico|reparse|raiz física/i);
    assert.deepEqual(result.state.attempts.at(-1).evidence, []);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish revalida hardlink criado por sensor verde', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-outside-'));
  const outsideFile = join(outside, 'shared.mjs');
  writeFileSync(outsideFile, 'export const value = 77;\n');
  const encoded = Buffer.from(outsideFile).toString('base64');
  const sensorCommand = `node -e "const fs=require('node:fs');const p=Buffer.from('${encoded}','base64').toString();fs.unlinkSync('src/app.mjs');fs.linkSync(p,'src/app.mjs')"`;
  const fx = fixture({ sensorCommand });
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 3;\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    if (result.failures.some((failure) => /EXDEV|EPERM|EACCES|ENOTSUP/.test(failure))) {
      t.skip(`hardlinks indisponíveis neste filesystem: ${result.failures.join('; ')}`);
      return;
    }
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /hardlink/i);
    assert.equal(result.state.attempts.at(-1).evidence[0].status, 'green');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] scan pós-sensor rejeita hardlink ignorado sob candidato protegido', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-protected-sensor-hardlink-'));
  const outsideFile = join(outside, 'shared.dat');
  writeFileSync(outsideFile, 'external\n');
  const encoded = Buffer.from(outsideFile).toString('base64');
  const sensorCommand = `node -e "const fs=require('node:fs');const p=Buffer.from('${encoded}','base64').toString();fs.mkdirSync('src/auth',{recursive:true});fs.linkSync(p,'src/auth/session.dat')"`;
  const fx = fixture({ sensorCommand });
  try {
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\nsrc/auth/\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore protected sensor output');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/app.mjs'] }));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 23;\n');

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    if (result.failures.some((failure) => /EXDEV|EPERM|EACCES|ENOTSUP/.test(failure))) {
      t.skip(`hardlinks indisponíveis neste filesystem: ${result.failures.join('; ')}`);
      return;
    }
    assert.equal(result.ok, false);
    assert.equal(result.state.attempts.at(-1).evidence[0].status, 'green');
    assert.match(result.failures.join('\n'), /scan físico protegido.*src\/auth\/session\.dat.*hardlink/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] projeção FLOW rejeita session_file redirecionado por junction', (t) => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'wk-flow-session-outside-'));
  const sessionDir = join(fx.vault, 'linked-session');
  try {
    writeFileSync(join(outside, 'flow.md'), readFileSync(fx.sessionPath, 'utf8'));
    try {
      symlinkSync(outside, sessionDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`links indisponíveis neste filesystem: ${error.code}`);
        return;
      }
      throw error;
    }
    writeSessionRegistry(fx.vault, {
      version: 2,
      sessions: {
        'session-1': {
          status: 'active', provider: 'codex', session_file: 'linked-session/flow.md', started_at: '2026-07-26T10:00:00.000Z',
        },
      },
    });
    assert.throws(
      () => startFlow(startArgs(fx)),
      /sessão|session_file|link simbólico|reparse|Vault/i,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish também detecta superfície sensível ignorada pelo Git', () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\n.env\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore local env');
    writeFileSync(join(fx.root, '.env'), 'TOKEN=before\n');
    const started = startFlow(startArgs(fx));

    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 8;\n');
    writeFileSync(join(fx.root, '.env'), 'TOKEN=after\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /\.env/);
    assert.match(result.failures.join('\n'), /fora da allowlist|superfície protegida/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish detecta superfície protegida built-in ignorada pelo Git', () => {
  const fx = fixture();
  try {
    const workflow = join(fx.root, '.github', 'workflows', 'ci.yml');
    mkdirSync(join(workflow, '..'), { recursive: true });
    writeFileSync(workflow, 'name: before\n');
    writeFileSync(join(fx.root, '.gitignore'), '.vault/\n.github/\n');
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore local workflow fixture');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/**', '.github/**'] }));

    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 11;\n');
    writeFileSync(workflow, 'name: after\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /superfície protegida.*\.github\/workflows\/ci\.yml/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] discovery canônica cobre tokens semânticos e schema leaf ignorados', () => {
  const fx = fixture();
  try {
    const protectedFiles = ['src/csrf.ts', 'src/passkeyService.ts', 'schema.sql'];
    for (const path of protectedFiles) writeFileSync(join(fx.root, ...path.split('/')), 'before\n');
    writeFileSync(join(fx.root, '.gitignore'), `.vault/\n${protectedFiles.join('\n')}\n`);
    git(fx.root, 'add', '.gitignore');
    git(fx.root, 'commit', '-qm', 'ignore protected semantic fixtures');
    const started = startFlow(startArgs(fx, { allowedPaths: ['src/**', 'schema.sql'] }));

    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 12;\n');
    for (const path of protectedFiles) writeFileSync(join(fx.root, ...path.split('/')), 'after\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });

    assert.equal(result.ok, false);
    for (const path of protectedFiles) assert.match(result.failures.join('\n'), new RegExp(path.replace('.', '\\.')));
    assert.match(result.failures.join('\n'), /superfície protegida/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish detecta mutação invisível dos metadados Git junto de mudança permitida', () => {
  const fx = fixture();
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 10;\n');
    git(fx.root, 'config', 'flow.adversarial', 'true');

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /metadados Git|git metadata|\.git\/config/i);
    assert.equal(readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id }).receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish bloqueia sensor crítico vermelho e preserva tentativa', () => {
  const fx = fixture({ sensorStatus: 1 });
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 3;\n');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /sensor.*focused/i);
    const state = readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id });
    assert.equal(state.state, 'active');
    assert.equal(state.attempts.at(-1).evidence[0].status, 'red');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish falha fechado quando um sensor verde modifica o repositório', () => {
  const sensorCommand = `node -e "require('node:fs').appendFileSync('package.json', ' ')"`;
  const fx = fixture({ sensorCommand });
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 5;\n');

    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /sensor.*modificou.*package\.json/i);
    const state = readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id });
    assert.equal(state.state, 'active');
    assert.equal(state.receipt, null);
    assert.equal(state.attempts.at(-1).evidence[0].status, 'green');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] finish persiste tentativa quando a configuração de sensores fica inválida', () => {
  const fx = fixture();
  try {
    const started = startFlow(startArgs(fx));
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 4;\n');
    writeFileSync(join(fx.root, 'wendkeep.sensors.json'), '{invalid');
    const result = finishFlow({ vaultBase: fx.vault, projectRoot: fx.root, flowId: started.contract.flow_id });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /sensores.*inválida|configuração.*sensor/i);
    const state = readFlow(fx.vault, { sessionId: 'session-1', flowId: started.contract.flow_id });
    assert.equal(state.attempts.length, 1);
    assert.equal(state.receipt, null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
