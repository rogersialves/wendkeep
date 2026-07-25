// CLI-SYNC-1/2 e PVR-SYNC-1: `wendkeep sync` encadeia init -> sync-defs -> doctor no
// projeto corrente. O bloqueador era process.exit em runSyncDefs/runDoctor, que matava o
// processo no segundo passo de qualquer encadeamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/doctor.mjs';
import { runSyncDefs } from '../src/sync-defs.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function freshProject() {
  const project = mkdtempSync(join(tmpdir(), 'wk-sync-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'proj-sync', version: '1.0.0' }));
  return project;
}

// Um vault mínimo já inicializado, para os passos que não podem depender do init real.
function vaultIn(project, name = '.proj-sync-vault') {
  const vault = join(project, name);
  mkdirSync(join(vault, '.brain'), { recursive: true });
  mkdirSync(join(vault, '02-Sessões'), { recursive: true });
  writeFileSync(join(project, '.wendkeep.json'), JSON.stringify({ vault: name }, null, 2));
  return vault;
}

const spawnWk = (args, opts = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

// --- CLI-SYNC-2: encadeáveis devolvem código, não saem -----------------------

test('runDoctor devolve o código em vez de encerrar o processo', () => {
  const project = freshProject();
  try {
    const vault = vaultIn(project);
    const code = runDoctor(['--vault', vault, '--project', project]);

    assert.equal(typeof code, 'number', 'devolve um código — se chamasse process.exit, o teste morreria aqui');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('runSyncDefs devolve o código em vez de encerrar o processo', () => {
  const project = freshProject();
  try {
    const vault = vaultIn(project);
    const code = runSyncDefs(['--vault', vault, '--project', project]);

    assert.equal(typeof code, 'number');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('o contrato externo do doctor não muda: código de saída observável', () => {
  const project = freshProject();
  try {
    const vault = vaultIn(project);
    const r = spawnWk(['doctor', '--vault', vault, '--project', project]);
    assert.ok(r.status === 0 || r.status === 1, `doctor sai 0 ou 1, saiu ${r.status}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('o contrato externo do sync-defs não muda: código de saída observável', () => {
  const project = freshProject();
  try {
    const vault = vaultIn(project);
    const r = spawnWk(['sync-defs', '--vault', vault, '--project', project]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- CLI-SYNC-1: o encadeamento ---------------------------------------------

test('sync roda os três passos em ordem no projeto corrente', () => {
  const project = freshProject();
  try {
    const r = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });

    assert.ok(r.status === 0 || r.status === 1, `saiu ${r.status}: ${r.stderr}`);
    const out = r.stdout;
    const iInit = out.indexOf('[1/3]');
    const iDefs = out.indexOf('[2/3]');
    const iDoctor = out.indexOf('[3/3]');
    assert.ok(iInit >= 0 && iDefs > iInit && iDoctor > iDefs, `os três passos, em ordem:\n${out}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('sync propaga o código do doctor sem tratar como falha da cadeia', () => {
  const project = freshProject();
  try {
    const r = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });

    assert.ok(r.stdout.includes('[3/3]'), 'o doctor rodou');
    assert.ok(r.status === 0 || r.status === 1, 'e o código dele é o do comando');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// Diretório inexistente NÃO serve de cenário de falha: o init o cria, e isso é o
// comportamento certo para um projeto novo. A falha real é config incompleta.
test('sync para no primeiro passo que falha', () => {
  const project = freshProject();
  try {
    writeFileSync(join(project, '.wendkeep.json'), '{"vault":".nao-existe-vault"}');

    const r = spawnWk(['sync', '--project', project, '--yes']);

    assert.notEqual(r.status, 0, 'sai diferente de zero');
    assert.match(r.stderr, /init falhou/);
    assert.ok(!r.stdout.includes('[2/3]'), 'sync-defs NÃO roda depois de o init falhar');
    assert.ok(!r.stdout.includes('[3/3]'), 'e o doctor tampouco');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('sync num projeto novo: o init cria o que falta em vez de falhar', () => {
  const project = freshProject();
  try {
    const r = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });

    assert.ok(r.status === 0 || r.status === 1, `saiu ${r.status}: ${r.stderr}`);
    assert.ok(existsSync(join(project, '.wendkeep.json')), 'projeto fica wirado');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- PVR-SYNC-1: env bleed --------------------------------------------------

// sync-defs resolve o vault por `--vault || OBSIDIAN_VAULT_PATH`. Num projeto novo, o env
// global da máquina vazaria e as skills iriam para o vault de outro projeto.
test('sync não deixa o OBSIDIAN_VAULT_PATH do ambiente sequestrar o projeto', () => {
  const project = freshProject();
  const alheio = mkdtempSync(join(tmpdir(), 'wk-vault-alheio-'));
  try {
    mkdirSync(join(alheio, '.brain'), { recursive: true });

    const r = spawnWk(['sync', '--project', project, '--yes'], {
      cwd: project,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: alheio },
    });

    assert.ok(r.status === 0 || r.status === 1, `saiu ${r.status}: ${r.stderr}`);
    assert.ok(!existsSync(join(alheio, '.brain', 'skills')),
      'as skills NÃO podem ir para o vault do env');
    assert.ok(existsSync(join(project, '.claude', 'skills')),
      'e vão para o projeto onde o sync foi invocado');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(alheio, { recursive: true, force: true });
  }
});

// O doctor sai 0 mesmo listando órfãos/seções desatualizadas (não são fatais). Uma linha
// final "tudo em dia" contradiria o relatório impresso logo acima.
test('sync não afirma que está tudo em dia por cima de um doctor com pendências', () => {
  const project = freshProject();
  try {
    const r = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });
    assert.doesNotMatch(r.stdout, /tudo em dia/, 'não contradiz o relatório acima');
    assert.match(r.stdout, /wendkeep sync: 3 passo\(s\) concluído\(s\)/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// O bug que este teste existe para impedir: `sync` chamava sync-defs SEM --reseed, então
// copiava o conteúdo antigo de .brain/skills para os destinos E carimbava a versão nova no
// .wendkeep-meta.json. O checkSyncDefs compara destino×.brain e meta×versão — os dois
// passavam a bater, e o doctor parava de acusar `defs stale` sem uma única skill atualizada.
// Silenciar o aviso sem resolver o problema é pior que não fazer nada.
//
// Discrimina pelo EFEITO (o conteúdo chega novo), não pela flag — testar que o argv contém
// '--reseed' seria testar a implementação.
test('sync ressemeia as skills wk-*: conteúdo antigo em .brain não sobrevive', () => {
  const project = freshProject();
  try {
    const first = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });
    assert.ok(first.status === 0 || first.status === 1, first.stderr);

    // O nome do vault vem do diretório do projeto (temp, aleatório) — leia do binding.
    const vaultName = JSON.parse(readFileSync(join(project, '.wendkeep.json'), 'utf8')).vault;
    const brainSkill = join(project, vaultName, '.brain', 'skills', 'wk-workflow', 'SKILL.md');
    assert.ok(existsSync(brainSkill), `pré-condição: ${brainSkill} semeado pelo init`);
    writeFileSync(brainSkill, '---\nname: wk-workflow\ndescription: versão velha\n---\ncorpo antigo\n');

    const again = spawnWk(['sync', '--project', project, '--yes'], { cwd: project });
    assert.ok(again.status === 0 || again.status === 1, again.stderr);

    const after = readFileSync(brainSkill, 'utf8');
    assert.doesNotMatch(after, /corpo antigo/, '.brain/skills recebeu o seed da versão instalada');

    for (const dest of ['.claude/skills', '.agents/skills']) {
      const copied = readFileSync(join(project, ...dest.split('/'), 'wk-workflow', 'SKILL.md'), 'utf8');
      assert.doesNotMatch(copied, /corpo antigo/, `${dest} propagou o conteúdo novo`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('sync aparece no help', () => {
  const r = spawnWk(['--help']);
  assert.match(r.stdout, /wendkeep sync/, 'o comando é descoberto pela ajuda');
});
