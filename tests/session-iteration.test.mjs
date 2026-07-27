import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertIterationContent, projectSessionIteration } from '../hooks/session-iteration.mjs';

const note = `---
type: session
session_id: session-1
status: active
---

# Sessão

## Iterações

### 10:00 - Existente
<!-- wk-turn: old -->

## Decisões geradas nesta sessão

- nenhuma

## Encerramento

Pendente.
`;

test('[req:OP-7] projeção FLOW entra em Iterações antes das seções derivadas e deduplica marcador', () => {
  const block = '### 12:00 - FLOW concluído\n\n- Recibo: `flow-1`';
  const first = insertIterationContent(note, { markerId: 'flow:flow-1:finished', block });
  assert.equal(first.inserted, true);
  assert.ok(first.content.indexOf('FLOW concluído') < first.content.indexOf('## Decisões geradas'));
  assert.match(first.content, /<!-- wk-turn: flow:flow-1:finished -->/);

  const second = insertIterationContent(first.content, { markerId: 'flow:flow-1:finished', block });
  assert.equal(second.inserted, false);
  assert.equal((second.content.match(/wk-turn: flow:flow-1:finished/g) || []).length, 1);
});

test('[req:OP-7] projeção em arquivo usa lock atômico e preserva frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-flow-session-'));
  try {
    const path = join(dir, 'session.md');
    writeFileSync(path, note);
    const result = projectSessionIteration(path, {
      markerId: 'flow:flow-1:finished',
      block: '### 12:00 - FLOW concluído\n\n- Sensor: `tests` green',
    });
    assert.equal(result.inserted, true);
    const content = readFileSync(path, 'utf8');
    assert.match(content, /^---\ntype: session/m);
    assert.ok(content.indexOf('FLOW concluído') < content.indexOf('## Encerramento'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[req:OP-7] projeção falha fechada em nota truncada', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wk-flow-session-'));
  try {
    const path = join(dir, 'session.md');
    writeFileSync(path, '# sem frontmatter\n\n## Iterações\n');
    const result = projectSessionIteration(path, {
      markerId: 'flow:flow-1:finished', block: '### não gravar',
    });
    assert.equal(result.inserted, false);
    assert.equal(result.reason, 'invalid-frontmatter');
    assert.equal(readFileSync(path, 'utf8'), '# sem frontmatter\n\n## Iterações\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
