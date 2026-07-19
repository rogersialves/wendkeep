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
