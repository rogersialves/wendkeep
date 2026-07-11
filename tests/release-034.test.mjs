import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wendkeep.mjs');

function run(vault, args) {
  return spawnSync(process.execPath, [BIN, ...args, '--vault', vault], { encoding: 'utf8' });
}

test('0.34 CLI: spec effective/migrate and change use/continue', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-034-'));
  try {
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), '# auth\n\n### Requisito: AUTH-1 — login\nbase\n');
    assert.equal(run(vault, ['change', 'new', 'a']).status, 0);
    assert.equal(run(vault, ['change', 'new', 'b']).status, 0);
    assert.equal(run(vault, ['change', 'use', 'a']).status, 0);
    assert.match(readFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'utf8'), /change: a/);

    const a = join(vault, '08-Mudanças', 'a');
    writeFileSync(join(a, 'proposta.md'), '---\nspecs: [auth]\n---\n');
    mkdirSync(join(a, 'specs', 'auth'), { recursive: true });
    writeFileSync(join(a, 'specs', 'auth', 'spec.md'), '## ADDED Requirements\n### Requisito: AUTH-2 — logout\ndelta\n\n## MODIFIED Requirements\n\n## REMOVED Requirements\n');
    const effective = run(vault, ['spec', 'effective', '--change', 'a', '--json']);
    assert.equal(effective.status, 0, effective.stderr);
    const json = JSON.parse(effective.stdout);
    assert.ok(json.specs[0].requirements.some((req) => req.id === 'AUTH-2' && req.operation === 'ADDED'));

    assert.equal(run(vault, ['spec', 'migrate']).status, 0);
    assert.ok(existsSync(join(vault, '.brain', 'SPECS_STATE.json')));

    const archived = join(vault, '08-Mudanças', '_arquivo', '2026-07-10-old');
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, 'proposta.md'), '---\nstatus: archived\n---\n# old\n');
    const continuation = run(vault, ['change', 'continue', 'old', 'next']);
    assert.equal(continuation.status, 0, continuation.stderr);
    assert.match(readFileSync(join(vault, '08-Mudanças', 'next', 'proposta.md'), 'utf8'), /continues:.*2026-07-10-old/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// E2E do ciclo concorrente (plano 0.34): duas changes abertas na MESMA capability; a segunda
// só bloqueia quando toca o MESMO requisito; `spec rebase --accept-current` destrava.
test('0.34 e2e: changes concorrentes na mesma capability — conflito real bloqueia, rebase destrava', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-034c-'));
  const fill = (slug) => {
    const dir = join(vault, '08-Mudanças', slug);
    writeFileSync(join(dir, 'proposta.md'), `---\ntype: change\nstatus: active\nspec_impact: required\nspecs: [auth]\n---\n\n# ${slug}\n\n## Por quê\n\nreal\n\n## O que muda\n\nreal\n`);
    writeFileSync(join(dir, 'design.md'), `# ${slug} — design\n\nreal\n`);
    writeFileSync(join(dir, 'tarefas.md'), '- [x] 1.1 feito\n');
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ slug, ok: true, coverage: [] }));
  };
  try {
    mkdirSync(join(vault, '04-Decisões'), { recursive: true });
    mkdirSync(join(vault, '07-Specs'), { recursive: true });
    writeFileSync(join(vault, '07-Specs', 'auth.md'), '# auth\n\n## Requisitos\n\n### Requisito: AUTH-1 — login\nbase\n\n### Requisito: AUTH-2 — logout\nbase\n');
    assert.equal(run(vault, ['spec', 'migrate']).status, 0);

    // duas changes abertas sobre a MESMA capability, baselines capturados no new
    assert.equal(run(vault, ['change', 'new', 'c1']).status, 0);
    assert.equal(run(vault, ['change', 'new', 'c2']).status, 0);
    fill('c1'); fill('c2');
    mkdirSync(join(vault, '08-Mudanças', 'c1', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'c1', 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: AUTH-1 — login\nc1 muda login\n');
    mkdirSync(join(vault, '08-Mudanças', 'c2', 'specs', 'auth'), { recursive: true });

    // c1 arquiva primeiro (sem conflito) e promove AUTH-1
    const a1 = run(vault, ['change', 'archive', 'c1']);
    assert.equal(a1.status, 0, a1.stderr);
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /c1 muda login/);

    // c2 toca requisito NÃO relacionado (AUTH-2) → prossegue apesar da mesma capability
    writeFileSync(join(vault, '08-Mudanças', 'c2', 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: AUTH-2 — logout\nc2 muda logout\n');
    // c2 toca o MESMO requisito (AUTH-1) → conflito real bloqueia
    writeFileSync(join(vault, '08-Mudanças', 'c2', 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: AUTH-1 — login\nc2 também muda login\n');
    const blocked = run(vault, ['change', 'archive', 'c2']);
    assert.equal(blocked.status, 1, 'conflito real bloqueia');
    assert.match(blocked.stderr, /conflito de spec.*AUTH-1|AUTH-1.*mudou/i);
    assert.match(blocked.stderr, /rebase/i, 'mensagem aponta o rebase');

    // rebase explícito aceita o estado atual e destrava
    const rebase = run(vault, ['spec', 'rebase', '--change', 'c2', '--accept-current']);
    assert.equal(rebase.status, 0, rebase.stderr);
    const a2 = run(vault, ['change', 'archive', 'c2']);
    assert.equal(a2.status, 0, a2.stderr);
    assert.match(readFileSync(join(vault, '07-Specs', 'auth.md'), 'utf8'), /c2 também muda login/);

    // alteração NÃO relacionada não bloqueia: c3 mexe só em AUTH-2 sobre baseline pós-c1
    assert.equal(run(vault, ['change', 'new', 'c3']).status, 0);
    fill('c3');
    mkdirSync(join(vault, '08-Mudanças', 'c3', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'c3', 'specs', 'auth', 'spec.md'), '## MODIFIED Requirements\n### Requisito: AUTH-2 — logout\nc3 muda logout\n');
    const a3 = run(vault, ['change', 'archive', 'c3']);
    assert.equal(a3.status, 0, `não-relacionado não bloqueia: ${a3.stderr}`);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
