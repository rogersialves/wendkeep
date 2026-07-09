// 0.31.0 — classe de bug "seção apagada": qualquer seção inserida entre '## Pendências' e
// '## Encerramento' era descartada pelo finalize do Stop (replacePendingSection reescreve o span
// inteiro). Visto em produção com '## Subagents & Workflows' (frontmatter sobrevivia, corpo não).
// Fix em duas camadas: upsertSection ancora ANTES de Pendências + o finalize preserva seções
// desconhecidas dentro do span.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSubagentUsage } from '../hooks/subagent-usage.mjs';
import { finalizeSessionFile } from '../hooks/session-stop.mjs';

function agentLine(model, input, output, cacheRead, tool, req) {
  return JSON.stringify({
    type: 'assistant', requestId: req,
    message: { id: req, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: `${req}-t`, name: tool }] },
  });
}

const NOTE_WITH_CLOSING = `---
type: session
tokens_total: 1000
ended_at:
status: active
---

# x

## Iterações

conteúdo

## Pendências

Nenhuma pendência identificada automaticamente.

## Encerramento

Em andamento.
`;

const TX = { rawTextForDetection: '', latestAssistantMessage: 'fim', userPrompts: [], tools: [] };

test('upsertSubagentUsage insere a seção ANTES de ## Pendências (fora do span reescrito)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sec1-'));
  try {
    const sd = join(parent, 'sess');
    mkdirSync(join(sd, 'subagents'), { recursive: true });
    writeFileSync(join(sd, 'subagents', 'agent-z9.jsonl'), agentLine('claude-opus-4-8', 1000, 500, 2000, 'Read', 'r1'));
    const notePath = join(parent, 'note.md');
    writeFileSync(notePath, NOTE_WITH_CLOSING);

    assert.equal(upsertSubagentUsage(notePath, `${sd}.jsonl`), true);
    const out = readFileSync(notePath, 'utf8');
    const sec = out.indexOf('## Subagents & Workflows');
    assert.ok(sec >= 0, 'seção presente');
    assert.ok(sec < out.indexOf('## Pendências'), 'seção antes de Pendências');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a seção Subagents sobrevive ao finalize do Stop (bug de produção)', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sec2-'));
  try {
    const sd = join(parent, 'sess');
    mkdirSync(join(sd, 'subagents'), { recursive: true });
    writeFileSync(join(sd, 'subagents', 'agent-z9.jsonl'), agentLine('claude-opus-4-8', 1000, 500, 2000, 'Read', 'r1'));
    const notePath = join(parent, 'note.md');
    writeFileSync(notePath, NOTE_WITH_CLOSING);
    upsertSubagentUsage(notePath, `${sd}.jsonl`);

    finalizeSessionFile(notePath, TX, { decisions: [], bugs: [], learnings: [] }, '2026-07-09T12:00:00');
    const out = readFileSync(notePath, 'utf8');
    assert.match(out, /## Subagents & Workflows/, 'seção sobrevive ao finalize');
    assert.match(out, /status: done/, 'finalize rodou de fato');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('classe: seção desconhecida dentro do span Pendências→Encerramento sobrevive ao finalize', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wk-sec3-'));
  try {
    const notePath = join(parent, 'note.md');
    // Nota histórica (pré-fix): '## Progresso do plano' (task-log) preso DENTRO do span.
    writeFileSync(notePath, `---
type: session
ended_at:
status: active
---

# x

## Pendências

- algo

## Progresso do plano

- [x] 10:00 fez A

## Encerramento

Em andamento.
`);
    finalizeSessionFile(notePath, TX, { decisions: [], bugs: [], learnings: [] }, '2026-07-09T12:00:00');
    const out = readFileSync(notePath, 'utf8');
    assert.match(out, /## Progresso do plano[\s\S]*fez A/, 'seção desconhecida preservada');
    assert.match(out, /## Pendências/, 'Pendências regenerada');
    assert.ok(out.indexOf('## Pendências') < out.indexOf('## Progresso do plano'), 'preservada após as Pendências novas');
    assert.ok(out.indexOf('## Progresso do plano') < out.indexOf('## Encerramento'), 'antes do Encerramento');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
