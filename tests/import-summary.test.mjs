// The harness injects blocks like <recommended_plugins> as the FIRST userPrompt of a turn;
// the user's real request is the LAST. buildIterationBlock already takes .at(-1) and gets it
// right — deriveSummary took .find(Boolean) and titled six Vendiva sessions with the injected
// block. Same data, opposite end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSummary } from '../hooks/import-sessions.mjs';
import { isBootstrapPrompt } from '../hooks/obsidian-common.mjs';

const INJECTED = '<recommended_plugins> Here is a list of plugins that are available but not '
  + 'installed. - Box (box@openai-curated-remote) - Figma (figma@openai-curated-remote)';
const REAL = 'Analise os arquivos nas pastas docs e design e vamos planejar o desenvolvimento do app';

// --- IMPORT-3 ----------------------------------------------------------------

test('deriveSummary: pega o pedido real, não o bloco injetado antes dele', () => {
  const tx = { turns: [{ userPrompts: [INJECTED, REAL] }] };
  const summary = deriveSummary(tx);
  assert.ok(summary.includes('Analise os arquivos'), `esperava o pedido real, veio: ${summary}`);
  assert.ok(!/recommended_plugins/i.test(summary), 'bloco do harness não pode titular a sessão');
});

test('deriveSummary: com dois pedidos legítimos no mesmo turno, vale o último', () => {
  // O caso que discrimina `.at(-1)` de `[0]`: sem dois prompts NÃO-bootstrap no mesmo turno,
  // o filtro sozinho já resolveria e a seleção poderia estar errada sem ninguém notar. O
  // bloco de iteração usa userPrompts.at(-1) (session-stop.mjs) — as duas têm que concordar,
  // senão o título da sessão contradiz o corpo dela.
  const tx = { turns: [{ userPrompts: ['Comece pelo backend', 'Na verdade, comece pelo frontend'] }] };
  assert.equal(deriveSummary(tx), 'Na verdade, comece pelo frontend');
});

test('deriveSummary: bloco injetado ENTRE dois pedidos não desloca a escolha', () => {
  const tx = { turns: [{ userPrompts: ['Comece pelo backend', INJECTED, 'Na verdade, pelo frontend'] }] };
  assert.equal(deriveSummary(tx), 'Na verdade, pelo frontend');
});

test('deriveSummary: turno só de bootstrap cede a vez pro turno seguinte', () => {
  const tx = { turns: [{ userPrompts: [INJECTED] }, { userPrompts: ['Opção C, modo Completo'] }] };
  assert.ok(deriveSummary(tx).includes('Opção C'));
});

test('deriveSummary: sem nenhum prompt aproveitável cai no fallback', () => {
  assert.equal(deriveSummary({ turns: [{ userPrompts: [INJECTED] }] }), 'session');
  assert.equal(deriveSummary({ turns: [] }), 'session');
  assert.equal(deriveSummary({}), 'session');
});

test('deriveSummary: prompt único e legítimo continua intacto', () => {
  const tx = { turns: [{ userPrompts: ['Opção C, modo Completo APP(Android) e WEB'] }] };
  assert.equal(deriveSummary(tx), 'Opção C, modo Completo APP(Android) e WEB');
});

test('deriveSummary: um prompt que apenas MENCIONA plugins não é descartado', () => {
  // A guarda contra filtro guloso: descartar por substring engoliria pedido legítimo.
  const tx = { turns: [{ userPrompts: ['Quais recommended_plugins devo instalar no projeto?'] }] };
  assert.ok(deriveSummary(tx).includes('Quais recommended_plugins'));
});

test('isBootstrapPrompt: reconhece o bloco de plugins injetado', () => {
  assert.equal(isBootstrapPrompt(INJECTED), true);
  assert.equal(isBootstrapPrompt(REAL), false);
  assert.equal(isBootstrapPrompt('Quais recommended_plugins devo instalar?'), false);
});

// --- OBS-4: o bloco de iteração usa o MESMO filtro do título ------------------

test('buildIterationBlock: Contexto conversado não mostra o bloco injetado como Usuário', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parseTranscript, buildIterationBlock } = await import('../hooks/session-stop.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
  const events = [
    { type: 'session_meta', timestamp: '2026-07-18T19:41:45.000Z', payload: { id: 'cx-conv', timestamp: '2026-07-18T19:41:45.000Z', cwd: 'C:\p', model: 'gpt-5', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:02.000Z', payload: { type: 'user_message', turn_id: 't1', message: INJECTED } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:03.000Z', payload: { type: 'user_message', turn_id: 't1', message: REAL } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:04.000Z', payload: { type: 'agent_message', turn_id: 't1', message: 'Analisado com sucesso.' } },
  ];
  const p = join(dir, 'rollout-2026-07-18T19-41-45-cx-conv.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

  const tx = parseTranscript(p);
  const block = buildIterationBlock(tx, { turn_id: 't1' });
  assert.ok(!block.includes('recommended_plugins'), 'preâmbulo do harness não é fala do usuário');
  assert.ok(block.includes(REAL), 'o pedido real permanece no contexto');
  assert.ok(block.includes('Analisado com sucesso'), 'a resposta permanece');
});

test('buildIterationBlock: prompt que MENCIONA o termo atravessa o filtro inteiro', async () => {
  // A guarda contra o filtro guloso, no caminho REAL (parseTranscript -> shouldIgnoreUserText),
  // não só no unitário de isBootstrapPrompt: um `/recommended_plugins/` sem âncora passaria lá
  // e ainda engoliria este pedido aqui.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parseTranscript, buildIterationBlock } = await import('../hooks/session-stop.mjs');

  const MENTION = 'Quais recommended_plugins devo instalar no projeto?';
  const dir = mkdtempSync(join(tmpdir(), 'wk-conv-mention-'));
  const events = [
    { type: 'session_meta', timestamp: '2026-07-18T19:41:45.000Z', payload: { id: 'cx-mention', timestamp: '2026-07-18T19:41:45.000Z', cwd: 'C:\\p', model: 'gpt-5', model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:01.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:02.000Z', payload: { type: 'user_message', turn_id: 't1', message: MENTION } },
    { type: 'event_msg', timestamp: '2026-07-18T19:42:03.000Z', payload: { type: 'agent_message', turn_id: 't1', message: 'Nenhum é obrigatório.' } },
  ];
  const p = join(dir, 'rollout-2026-07-18T19-41-45-cx-mention.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

  const block = buildIterationBlock(parseTranscript(p), { turn_id: 't1' });
  assert.ok(block.includes(MENTION), 'pedido legítimo não pode ser engolido por substring');
});

// [req:OP-10] Truncar uma entrada no meio de código inline/fence não pode deixar um
// delimitador casar com a próxima linha e transformar a entrada seguinte em code span.
test('buildIterationBlock: truncamento mantém backticks confinados à própria linha', async () => {
  const { buildIterationBlock } = await import('../hooks/session-stop.mjs');
  const short = 'use `codigo-curto` normalmente';
  const inlineBySlashParity = Array.from({ length: 5 }, (_, slashCount) => (
    `${'a'.repeat(490 - slashCount)} ${'\\'.repeat(slashCount)}\`codigo-depois-do-limite\``
  ));
  const fence = `${'b'.repeat(490)} \`\`\`javascript-depois-do-limite\`\`\``;
  const conversation = [short, ...inlineBySlashParity, fence, fence]
    .map((text) => ({ role: 'Assistente', text }));
  const tx = {
    turns: [{
      turnId: 't-markdown',
      timestamp: '2026-07-26T18:00:00.000Z',
      userPrompts: ['registre a iteração'],
      assistantMessages: ['feito'],
      tools: [],
      consultedFiles: [],
      changedFiles: [],
      conversation,
      usage: {},
    }],
    latestTurnId: 't-markdown',
  };

  const block = buildIterationBlock(tx, { turn_id: 't-markdown' });
  const entries = block.split('\n').filter((line) => line.startsWith('- **Assistente:**'));
  assert.equal(entries.length, conversation.length, 'nenhuma entrada seguinte é engolida');
  assert.match(entries[0], /`codigo-curto`/, 'código inline completo continua formatado');
  const unescapedBacktickRuns = (line) => {
    const lengths = [];
    for (let index = 0; index < line.length;) {
      if (line[index] !== '`') {
        index += 1;
        continue;
      }
      let precedingBackslashes = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
        precedingBackslashes += 1;
      }
      if (precedingBackslashes % 2 === 1) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < line.length && line[end] === '`') end += 1;
      lengths.push(end - index);
      index = end;
    }
    return lengths;
  };
  for (const line of entries) {
    const countsByRunLength = new Map();
    for (const length of unescapedBacktickRuns(line)) {
      countsByRunLength.set(length, (countsByRunLength.get(length) || 0) + 1);
    }
    for (const [length, count] of countsByRunLength) {
      assert.equal(count % 2, 0, `linha deixou delimitador de ${length} backtick(s) aberto`);
    }
  }
  assert.match(block, /\n\*\*Ferramentas usadas:\*\*/, 'a próxima seção continua fora de code span');
});

test('[req:IMPORT-6] buildIterationBlock limpa metadados internos sem apagar a menção do usuário', async () => {
  const { buildIterationBlock } = await import('../hooks/session-stop.mjs');
  const userMention = 'O erro exibiu <oai-mem-citation> <citation_entries> no Obsidian.';
  const assistantWithMetadata = [
    'A causa foi isolada.',
    '</session>',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:1-2|note=[internal]',
    '</citation_entries>',
    '<rollout_ids>019f-example</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');
  const tx = {
    latestTurnId: 'metadata-turn',
    latestUserPrompt: userMention,
    latestAssistantMessage: assistantWithMetadata,
    model: '',
    tools: [],
    turns: [{
      turnId: 'metadata-turn',
      timestamp: '2026-08-01T13:00:00.000Z',
      userPrompts: [userMention],
      assistantMessages: [assistantWithMetadata],
      conversation: [
        { role: 'Usuário', text: userMention },
        { role: 'Assistente', text: assistantWithMetadata },
      ],
      tools: [],
      consultedFiles: [],
      changedFiles: [],
      usage: {},
      model: '',
    }],
  };

  const block = buildIterationBlock(tx, { turn_id: 'metadata-turn' });
  const userLine = block.split('\n').find((line) => line.startsWith('- **Usuário:**'));
  const assistantLine = block.split('\n').find((line) => line.startsWith('- **Assistente:**'));
  const stateLine = block.split('\n').find((line) => line.startsWith('**Estado ao final do turno:**'));

  assert.match(userLine, /&lt;oai-mem-citation&gt; &lt;citation_entries&gt;/, 'a reprodução do usuário permanece visível');
  assert.equal(assistantLine, '- **Assistente:** A causa foi isolada.');
  assert.equal(stateLine, '**Estado ao final do turno:** A causa foi isolada.');
});

test('buildIterationBlock: placeholders XML-like ficam visíveis sem quebrar o Markdown', async () => {
  const { buildIterationBlock } = await import('../hooks/session-stop.mjs');
  const prompt = 'Valide <session>, </session> e o autolink <https://example.com>.';
  const assistant = 'Use <sessão> como placeholder; </sessão> também deve aparecer.';
  const tx = {
    latestTurnId: 'xml-placeholder-turn',
    latestUserPrompt: prompt,
    latestAssistantMessage: assistant,
    model: '',
    tools: [],
    turns: [{
      turnId: 'xml-placeholder-turn',
      timestamp: '2026-08-01T13:00:00.000Z',
      userPrompts: [prompt],
      assistantMessages: [assistant],
      conversation: [
        { role: 'Usuário', text: prompt },
        { role: 'Assistente', text: assistant },
      ],
      tools: [],
      consultedFiles: [],
      changedFiles: [],
      usage: {},
      model: '',
    }],
  };

  const block = buildIterationBlock(tx, { turn_id: 'xml-placeholder-turn' });

  assert.match(block, /&lt;session&gt;/);
  assert.match(block, /&lt;\/session&gt;/);
  assert.match(block, /&lt;sessão&gt;/u);
  assert.match(block, /&lt;\/sessão&gt;/u);
  assert.match(block, /<https:\/\/example\.com>/, 'autolinks Markdown não devem ser codificados');
});

test('[req:IMPORT-6] sessionFinalSummary remove envelopes e escapa XML-like sem quebrar autolinks', async () => {
  const { sessionFinalSummary } = await import('../hooks/session-stop.mjs');
  const summary = sessionFinalSummary({
    latestAssistantMessage: [
      'Concluído com <session>estado</session> e <https://example.com/prova>.',
      '<oai-mem-citation>',
      '<citation_entries>MEMORY.md:1-2|note=[internal]</citation_entries>',
      '<rollout_ids>019f-example</rollout_ids>',
      '</oai-mem-citation>',
    ].join('\n'),
    userPrompts: [],
    tools: [],
  });

  assert.equal(
    summary,
    'Concluído com &lt;session&gt;estado&lt;/session&gt; e <https://example.com/prova>.',
  );
  assert.doesNotMatch(summary, /oai-mem-citation|citation_entries|rollout_ids/);
});

test('[req:IMPORT-6] reimport e SessionStop convergem para sanitização idempotente', async () => {
  const { parseCodexTranscriptContent } = await import('../packages/integrations/src/transcripts.mjs');
  const { sanitizeAssistantMessage } = await import('../packages/integrations/src/prompt-content.mjs');
  const { sessionFinalSummary } = await import('../hooks/session-stop.mjs');
  const cases = [
    'Resposta citation.\n<citation_entries>x',
    'Resposta rollout.\n<rollout_ids>x',
    'Resposta adjacente.\n</session><oai-mem-citation><citation_entries>x',
    `Resposta múltipla.\n${Array.from({ length: 5 }, (_, index) => (
      `<oai-mem-citation><citation_entries>${index}</citation_entries></oai-mem-citation>`
    )).join('\n')}`,
  ];

  for (const [index, raw] of cases.entries()) {
    const expected = raw.slice(0, raw.indexOf('\n'));
    const turnId = `import-6-${index}`;
    const transcript = [
      { type: 'turn_context', timestamp: '2026-08-01T13:00:00.000Z', payload: { turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'agent_message', turn_id: turnId, message: raw } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const reimported = parseCodexTranscriptContent(transcript, {
      repoRoot: 'C:\\work\\demo',
      vaultRoot: 'C:\\work\\demo\\.WendKeep-vault',
    });
    const stopSummary = sessionFinalSummary({
      latestAssistantMessage: raw,
      userPrompts: [],
      tools: [],
    });

    assert.equal(reimported.latestAssistantMessage, expected);
    assert.equal(stopSummary, expected);
    assert.equal(sanitizeAssistantMessage(sanitizeAssistantMessage(raw)), expected);
  }
});
