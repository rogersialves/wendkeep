import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionRegistry } from '../hooks/obsidian-common.mjs';
import { runFlow } from '../src/flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wk-flow-cli-'));
  const vault = join(root, '.vault');
  const sessionRel = '02-Sessões/flow-cli.md';
  const sessionPath = join(vault, ...sessionRel.split('/'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(sessionPath, '..'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'other.txt'), 'base\n');
  writeFileSync(join(root, '.gitignore'), '.vault/\n');
  writeFileSync(join(root, 'wendkeep.sensors.json'), JSON.stringify({
    version: 1,
    sensors: [{ id: 'focused', severity: 'critical', command: 'node -e "process.exit(0)"' }],
  }));
  writeFileSync(sessionPath, `---
type: session
session_id: flow-cli-session
status: active
---

# CLI FLOW

## Iterações

## Encerramento
`);
  writeSessionRegistry(vault, {
    version: 2,
    sessions: {
      'flow-cli-session': { status: 'active', provider: 'codex', session_file: sessionRel },
    },
  });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'flow@example.invalid');
  git(root, 'config', 'user.name', 'FLOW CLI Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return { root, vault };
}

function io() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
      env: {},
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function common(fx) {
  return ['--project', fx.root, '--vault', fx.vault, '--session', 'flow-cli-session', '--json'];
}

test('[req:OP-6] CLI canônica start/status/show/finish mantém FLOW consultável sem change', async () => {
  const fx = fixture();
  try {
    const startIo = io();
    const startCode = await runFlow([
      'start', 'cli-small',
      '--allow', 'src/app.mjs',
      '--sensor', 'focused',
      '--reason', 'correção pequena via CLI',
      ...common(fx),
    ], startIo.streams);
    assert.equal(startCode, 0, startIo.stderr());
    const started = JSON.parse(startIo.stdout());
    assert.equal(started.state, 'active');
    assert.deepEqual(started.contract.allowed_paths, ['src/app.mjs']);
    assert.equal(existsSync(join(fx.vault, '08-Mudanças')), false);

    for (const sub of ['status', 'show']) {
      const queryIo = io();
      assert.equal(await runFlow([sub, started.contract.flow_id, ...common(fx)], queryIo.streams), 0);
      assert.equal(JSON.parse(queryIo.stdout()).state, 'active');
    }

    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 2;\n');
    const finishIo = io();
    assert.equal(await runFlow(['finish', started.contract.flow_id, ...common(fx)], finishIo.streams), 0, finishIo.stderr());
    const finished = JSON.parse(finishIo.stdout());
    assert.equal(finished.ok, true);
    assert.equal(finished.state.state, 'finished');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] CLI finish usa exit 1 para gate vermelho e promote cria change normal', async () => {
  const fx = fixture();
  try {
    const startIo = io();
    assert.equal(await runFlow([
      'start', 'cli-promote', '--allow', 'src/app.mjs', '--sensor', 'focused',
      '--reason', 'escopo cresceu', ...common(fx),
    ], startIo.streams), 0);
    const flowId = JSON.parse(startIo.stdout()).contract.flow_id;
    writeFileSync(join(fx.root, 'other.txt'), 'fora do contrato\n');

    const finishIo = io();
    assert.equal(await runFlow(['finish', flowId, ...common(fx)], finishIo.streams), 1);
    assert.match(JSON.parse(finishIo.stdout()).failures.join('\n'), /fora da allowlist/i);

    const promoteIo = io();
    assert.equal(await runFlow(['promote', flowId, ...common(fx)], promoteIo.streams), 0, promoteIo.stderr());
    const promoted = JSON.parse(promoteIo.stdout());
    assert.equal(promoted.state.state, 'promoted');
    assert.ok(existsSync(join(fx.vault, '08-Mudanças', 'cli-promote', 'flow-origin.json')));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-7] CLI promote aceita slug alternativo para retry após disputa de ownership', async () => {
  const fx = fixture();
  try {
    const startIo = io();
    assert.equal(await runFlow([
      'start', 'slug-original', '--allow', 'src/app.mjs', '--sensor', 'focused',
      '--reason', 'retry explícito em outro slug', ...common(fx),
    ], startIo.streams), 0, startIo.stderr());
    const flowId = JSON.parse(startIo.stdout()).contract.flow_id;

    const promoteIo = io();
    assert.equal(await runFlow([
      'promote', flowId, '--change-slug', 'slug-alternativo', ...common(fx),
    ], promoteIo.streams), 0, promoteIo.stderr());
    const promoted = JSON.parse(promoteIo.stdout());
    assert.equal(promoted.state.promotion.change_slug, 'slug-alternativo');
    assert.ok(existsSync(join(fx.vault, '08-Mudanças', 'slug-alternativo', 'flow-origin.json')));
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'slug-original')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-9] ajuda pública de flow expõe o microcontrato completo sem resolver Vault', () => {
  const result = spawnSync(process.execPath, ['bin/wendkeep.mjs', 'flow', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /start <slug> --allow <path>\.\.\. --sensor <id>\.\.\. --reason <text>/);
  assert.match(result.stdout, /promote <id> \[--change-slug <slug>\]/);
  assert.match(result.stdout, /--project <path> --vault <path> --session <id> --json/);
  assert.match(result.stdout, /no --force option/i);
});

test('[req:OP-7] --change-slug é singleton e exclusivo de promote', async () => {
  const fx = fixture();
  try {
    for (const argv of [
      ['status', '--change-slug', 'nope', ...common(fx)],
      [
        'start', 'nope', '--allow', 'src/app.mjs', '--sensor', 'focused', '--reason', 'nope',
        '--change-slug', 'invalid-here', ...common(fx),
      ],
      ['promote', 'missing', '--change-slug', 'one', '--change-slug=two', ...common(fx)],
    ]) {
      const attemptIo = io();
      assert.equal(await runFlow(argv, attemptIo.streams), 2);
      assert.match(attemptIo.stderr(), /change-slug|duplicada/i);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-6] CLI rejeita microcontrato incompleto e qualquer --force com exit 2', async () => {
  const fx = fixture();
  try {
    const missingIo = io();
    assert.equal(await runFlow([
      'start', 'incomplete', '--allow', 'src/app.mjs', '--sensor', 'focused', ...common(fx),
    ], missingIo.streams), 2);
    assert.match(missingIo.stderr(), /reason|motivo/i);

    const forceIo = io();
    assert.equal(await runFlow(['finish', 'any-id', '--force', ...common(fx)], forceIo.streams), 2);
    assert.match(forceIo.stderr(), /opção desconhecida.*--force/i);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-6] --session restringe lookup e mutações ao dono do FLOW', async () => {
  const fx = fixture();
  try {
    const startIo = io();
    assert.equal(await runFlow([
      'start', 'session-scoped', '--allow', 'src/app.mjs', '--sensor', 'focused',
      '--reason', 'lookup deve respeitar sessão', ...common(fx),
    ], startIo.streams), 0, startIo.stderr());
    const flowId = JSON.parse(startIo.stdout()).contract.flow_id;
    writeFileSync(join(fx.root, 'src', 'app.mjs'), 'export const value = 9;\n');

    for (const sub of ['show', 'finish', 'promote']) {
      const attemptIo = io();
      const code = await runFlow([
        sub, flowId,
        '--project', fx.root,
        '--vault', fx.vault,
        '--session', 'another-session',
        '--json',
      ], attemptIo.streams);
      assert.equal(code, 2, `${sub}: ${attemptIo.stderr()}`);
      assert.match(attemptIo.stderr(), /FLOW não encontrado/i);
    }

    const statusIo = io();
    assert.equal(await runFlow(['show', flowId, ...common(fx)], statusIo.streams), 0, statusIo.stderr());
    assert.equal(JSON.parse(statusIo.stdout()).state, 'active');
    assert.equal(existsSync(join(fx.vault, '08-Mudanças', 'session-scoped')), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-6] CLI rejeita opções singleton duplicadas antes de mutar o Vault', async () => {
  const fx = fixture();
  try {
    const cases = [
      ['--session', 'flow-cli-session', '--session=flow-cli-session'],
      ['--project', fx.root, `--project=${fx.root}`],
      ['--vault', fx.vault, `--vault=${fx.vault}`],
      ['--reason', 'primeiro motivo', '--reason=segundo motivo'],
      ['--json', '--json'],
    ];

    for (const duplicated of cases) {
      const attemptIo = io();
      const code = await runFlow([
        'start', 'duplicate-singleton',
        '--allow', 'src/app.mjs',
        '--sensor', 'focused',
        '--reason', 'motivo base',
        '--project', fx.root,
        '--vault', fx.vault,
        '--session', 'flow-cli-session',
        ...duplicated,
      ], attemptIo.streams);
      assert.equal(code, 2, `${duplicated.join(' ')}\n${attemptIo.stderr()}`);
      assert.match(attemptIo.stderr(), /duplicada/i);
      assert.equal(existsSync(join(fx.vault, '.brain', 'runtime', 'flows')), false);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('[req:OP-6] CLI mantém repetição intencional de --allow e --sensor', async () => {
  const fx = fixture();
  try {
    const startIo = io();
    const code = await runFlow([
      'start', 'repeatable-options',
      '--allow', 'src/app.mjs',
      '--allow=other.txt',
      '--sensor', 'focused',
      '--sensor=focused',
      '--reason', 'contrato com opções repetíveis',
      ...common(fx),
    ], startIo.streams);
    assert.equal(code, 0, startIo.stderr());
    const started = JSON.parse(startIo.stdout());
    assert.deepEqual(started.contract.allowed_paths, ['other.txt', 'src/app.mjs']);
    assert.deepEqual(started.contract.sensor_ids, ['focused']);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
