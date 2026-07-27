import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function freshProject(prefix = 'wk-profile-init-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function spawnWk(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
}

function init(project, extra = [], { withMcp = false } = {}) {
  return spawnWk([
    'init',
    '--project', project,
    '--vault', join(project, '.vault'),
    '--locale', 'pt-BR',
    ...(withMcp ? [] : ['--no-mcp']),
    '--no-companions',
    '--no-colors',
    '--yes',
    ...extra,
  ]);
}

function binding(project) {
  return JSON.parse(readFileSync(join(project, '.wendkeep.json'), 'utf8'));
}

test('[req:OP-2] instalação nova sem --profile persiste GOVERN', () => {
  const project = freshProject();
  try {
    const result = init(project);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(binding(project).harness.profile, 'GOVERN');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-2] --profile explícito é canônico, estrito e não altera binding ao falhar', () => {
  const project = freshProject();
  try {
    const selected = init(project, ['--profile=flow']);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(binding(project).harness.profile, 'FLOW');

    const invalid = init(project, ['--profile', 'turbo']);
    assert.notEqual(invalid.status, 0, 'perfil inválido deve falhar');
    assert.match(invalid.stderr, /Perfil de Operação inválido/);
    assert.equal(binding(project).harness.profile, 'FLOW', 'falha estrita não muta o binding');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-2] re-init sem --profile preserva o perfil configurado', () => {
  const project = freshProject();
  try {
    const first = init(project, ['--profile', 'ASSURE']);
    assert.equal(first.status, 0, first.stderr);

    const second = init(project);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(binding(project).harness.profile, 'ASSURE');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-4] init OFF mantém Vault, hooks, MCP e skills instalados', () => {
  const project = freshProject('wk-profile-off-');
  const vault = join(project, '.vault');
  try {
    const result = init(project, ['--profile', 'OFF'], { withMcp: true });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(binding(project).harness.profile, 'OFF');
    assert.ok(existsSync(join(vault, '.brain', 'PROJECT.json')), 'Vault continua vinculado');
    assert.ok(
      existsSync(join(project, '.agents', 'skills', 'wk-workflow', 'SKILL.md')),
      'skills continuam instaladas',
    );
    const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'));
    assert.match(JSON.stringify(settings.hooks), /wendkeep hook/, 'hooks continuam instalados');
    const mcp = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['wendkeep-vault'], 'MCP do Vault continua instalado');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-6] init recomenda ignorar somente o runtime local de FLOW', () => {
  const project = freshProject();
  try {
    const result = init(project, ['--profile', 'FLOW']);

    assert.equal(result.status, 0, result.stderr);
    const ignoreLine = result.stdout.split(/\r?\n/).find((line) => line.includes('.brain/.change-*')) || '';
    assert.match(ignoreLine, /\.brain\/runtime\/flows\//);
    assert.doesNotMatch(ignoreLine, /\.brain\/\*/);
    assert.doesNotMatch(ignoreLine, /07-Specs|08-Mudanças|docs/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-2] sync novo sem --profile persiste GOVERN', () => {
  const project = freshProject('wk-profile-sync-');
  try {
    const result = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });

    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    assert.equal(binding(project).harness.profile, 'GOVERN');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-2] sync persiste flag explícita e a preserva nas execuções seguintes', () => {
  const project = freshProject('wk-profile-sync-');
  try {
    const selected = spawnWk(['sync', '--project', project, '--profile', 'GUIDE', '--yes'], { cwd: project });
    assert.ok(selected.status === 0 || selected.status === 1, selected.stderr);
    assert.equal(binding(project).harness.profile, 'GUIDE');

    const preserved = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });
    assert.ok(preserved.status === 0 || preserved.status === 1, preserved.stderr);
    assert.equal(binding(project).harness.profile, 'GUIDE');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('[req:OP-2] sync rejeita --profile inválido sem substituir o perfil existente', () => {
  const project = freshProject('wk-profile-sync-');
  try {
    const first = spawnWk(['sync', '--project', project, '--profile', 'FLOW', '--yes'], { cwd: project });
    assert.ok(first.status === 0 || first.status === 1, first.stderr);

    const invalid = spawnWk(['sync', '--project', project, '--profile=turbo', '--yes'], { cwd: project });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Perfil de Operação inválido/);
    assert.equal(binding(project).harness.profile, 'FLOW');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
