import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costBreakdown, priceForModel } from '../hooks/token-usage.mjs';
import { checkUnpricedModels, renderUnpricedModelLines } from '../hooks/harness-doctor.mjs';

// --- OBS-9: a tabela cobre os modelos correntes -----------------------------

test('priceForModel: claude-opus-5 tem o preço do tier Opus', () => {
  const p = priceForModel('claude-opus-5');
  assert.ok(p, 'claude-opus-5 deve estar na tabela');
  assert.equal(p.input, 5);
  assert.equal(p.cachedInput, 0.5, 'cache read é 0,1x o input');
  assert.equal(p.output, 25);
  assert.equal(p.provider, 'anthropic');
});

test('priceForModel: claude-mythos-5 tem o preço do tier Fable', () => {
  const p = priceForModel('claude-mythos-5');
  assert.ok(p, 'claude-mythos-5 deve estar na tabela');
  assert.equal(p.input, 10);
  assert.equal(p.cachedInput, 1);
  assert.equal(p.output, 50);
});

test('priceForModel: variantes de escrita do id resolvem para o mesmo preço', () => {
  const base = priceForModel('claude-opus-5');
  for (const variant of ['anthropic/claude-opus-5', 'claude-opus-5-0', 'claude-opus-5[1m]']) {
    assert.deepEqual(priceForModel(variant), base, `${variant} deve resolver como claude-opus-5`);
  }
  assert.deepEqual(priceForModel('anthropic/claude-mythos-5'), priceForModel('claude-mythos-5'));
});

test('priceForModel: Spark é conhecido como research preview sem tarifa inventada', () => {
  const base = priceForModel('gpt-5.3-codex-spark');
  assert.ok(base, 'Spark deve ser reconhecido pela tabela');
  assert.equal(base.pricingStatus, 'research-preview');
  assert.equal(base.input, null);
  assert.equal(base.cachedInput, null);
  assert.equal(base.output, null);

  for (const variant of [
    'gpt-5-3-codex-spark',
    'openai/gpt-5.3-codex-spark',
    'openai/gpt-5-3-codex-spark[1m]',
  ]) {
    assert.deepEqual(priceForModel(variant), base, `${variant} deve resolver para Spark`);
  }

  const breakdown = costBreakdown({ input: 1_000_000, cached: 500_000, cacheWrite: 100_000, output: 250_000 }, base);
  assert.equal(breakdown.total, 0, 'sem tarifa final o custo não pode receber estimativa inventada');
});

// O regime de falha que motivou a change: uso real fechando com custo zero.
test('priceForModel: uso em claude-opus-5 custa mais que zero', () => {
  const p = priceForModel('claude-opus-5');
  const custoDe1MInput = (1_000_000 / 1_000_000) * (p?.input ?? 0);
  assert.ok(custoDe1MInput > 0, '1M tokens de input não podem custar $0');
});

// --- OBS-10: modelo sem preço é sinalizado ----------------------------------

// Forma real da nota: `modelo` é o rótulo agregado, `modelos` a lista canônica.
const note = ({ models, tokens, custo }) => [
  '---', 'type: session', `modelo: "${models.join(' + ')}"`,
  'modelos:', ...models.map((m) => `  - "${m}"`),
  `tokens_total: ${tokens}`, `custo_modelo_usd: ${custo}`, '---', '', '# sessão', '',
].join('\n');

function vaultWith(notes) {
  const vault = mkdtempSync(join(tmpdir(), 'wk-unpriced-'));
  const dir = join(vault, '02-Sessões', '2026', '07-JUL', 'DIA 25');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(notes)) writeFileSync(join(dir, name), content);
  return vault;
}

test('checkUnpricedModels: acha o modelo ausente da tabela', () => {
  const vault = vaultWith({
    'a.md': note({ models: ['claude-inexistente-9'], tokens: 5000, custo: 0 }),
    'b.md': note({ models: ['claude-opus-4.8'], tokens: 8000, custo: 1.23 }),
  });
  try {
    const r = checkUnpricedModels(vault);
    assert.deepEqual(r.models.map((m) => m.model), ['claude-inexistente-9']);
    assert.equal(r.models[0].notes, 1);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// O caso REAL que motivou a change: a nota do ObservatorioPolitico fecha com $415 porque
// Opus 4.8 e Fable 5 têm preço — só a fatia do terceiro modelo é que ficou zerada. Um
// detector que procurasse `custo_modelo_usd: 0` passaria batido justamente aqui.
test('checkUnpricedModels: acha o modelo sem preço numa sessão multi-modelo com custo alto', () => {
  const vault = vaultWith({
    'real.md': note({
      models: ['claude-opus-4.8', 'claude-fable-5', 'claude-inexistente-9'],
      tokens: 695001296,
      custo: 415.1589,
    }),
  });
  try {
    const r = checkUnpricedModels(vault);
    assert.deepEqual(r.models.map((m) => m.model), ['claude-inexistente-9'],
      'custo agregado > 0 não pode esconder o modelo sem preço');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkUnpricedModels: separa research preview de modelo realmente desconhecido', () => {
  const vault = vaultWith({
    'preview.md': note({ models: ['gpt-5.3-codex-spark'], tokens: 5000, custo: 0 }),
    'unknown.md': note({ models: ['claude-inexistente-9'], tokens: 5000, custo: 0 }),
  });
  try {
    const r = checkUnpricedModels(vault);
    assert.deepEqual(r.models.map((m) => m.model), ['claude-inexistente-9']);
    assert.deepEqual(r.researchPreview, [{ model: 'gpt-5.3-codex-spark', notes: 1 }]);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkUnpricedModels: sessão sem uso não é sintoma', () => {
  const vault = vaultWith({ 'vazia.md': note({ models: ['claude-qualquer'], tokens: 0, custo: 0 }) });
  try {
    assert.deepEqual(checkUnpricedModels(vault).models, [], 'custo zero sem uso é correto');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkUnpricedModels: mesmo modelo em várias notas é reportado uma vez, com a contagem', () => {
  const vault = vaultWith({
    'a.md': note({ models: ['claude-inexistente-9'], tokens: 5000, custo: 0 }),
    'b.md': note({ models: ['claude-inexistente-9'], tokens: 7000, custo: 0 }),
  });
  try {
    const r = checkUnpricedModels(vault);
    assert.equal(r.models.length, 1);
    assert.equal(r.models[0].notes, 2);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('checkUnpricedModels: vault sem notas de sessão devolve vazio', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-unpriced-vazio-'));
  try {
    assert.deepEqual(checkUnpricedModels(vault).models, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor imprime os modelos sem preço e o arquivo a editar', () => {
  const vault = vaultWith({ 'a.md': note({ models: ['claude-inexistente-9'], tokens: 5000, custo: 0 }) });
  try {
    const lines = renderUnpricedModelLines(checkUnpricedModels(vault));
    assert.match(lines[0], /^\[preços\] 1 modelo\(s\) sem preço/);
    assert.ok(lines.some((l) => l.includes('claude-inexistente-9')), 'nomeia o modelo');
    assert.ok(lines.some((l) => l.includes('hooks/pricing.json')), 'aponta o arquivo a editar');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor diz que a tabela está completa quando não há modelo sem preço', () => {
  const vault = vaultWith({ 'b.md': note({ models: ['claude-opus-4.8'], tokens: 8000, custo: 1.23 }) });
  try {
    const lines = renderUnpricedModelLines(checkUnpricedModels(vault));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /tabela de preços completa/);
    assert.ok(!lines.some((l) => l.includes('pricing.json')), 'vault são não sugere edição');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('doctor explica research preview sem mandar inventar preço', () => {
  const vault = vaultWith({
    'preview.md': note({ models: ['gpt-5.3-codex-spark'], tokens: 5000, custo: 0 }),
  });
  try {
    const lines = renderUnpricedModelLines(checkUnpricedModels(vault));
    assert.match(lines[0], /^\[preços\] 0 modelo\(s\) sem preço/);
    assert.ok(lines.some((line) => /research preview/i.test(line)));
    assert.ok(lines.some((line) => /tarifa final|não estimado/i.test(line)));
    assert.ok(!lines.some((line) => line.includes('adicione o modelo')),
      'modelo conhecido sem tarifa não deve pedir preço inventado');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
