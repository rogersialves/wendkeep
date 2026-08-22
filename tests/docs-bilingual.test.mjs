// DOC-1..DOC-9 — the public CLI documentation is a bilingual, navigable package surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = [
  'getting-started.md',
  'operating-profiles.md',
  'changes-and-verification.md',
  'memory.md',
  'sessions-and-import.md',
  'notes-and-knowledge.md',
  'costs-and-observability.md',
  'maintenance-and-diagnostics.md',
  'verify.md',
  'memory-migration.md',
  'retroactive-import.md',
  'observer.md',
  'worktrees.md',
  'context.md',
];
const GUIDE_DIR = {
  pt: join(ROOT, 'docs', 'pt-BR', 'commands'),
  en: join(ROOT, 'docs', 'en', 'commands'),
};
const REQUIRED_SECTIONS = {
  pt: [
    'Objetivo', 'Quando usar', 'Quando não usar', 'Pré-requisitos', 'Sintaxe',
    'Opções e códigos de saída', 'Exemplos', 'Resultado esperado',
    'Erros comuns e diagnóstico', 'Próximos passos',
  ],
  en: [
    'Purpose', 'When to use', 'When not to use', 'Prerequisites', 'Syntax',
    'Options and exit codes', 'Examples', 'Expected result',
    'Common errors and diagnosis', 'Next steps',
  ],
};
const README_GROUPS = [
  { pt: 'Instalação e atualização', en: 'Installation and updates', guide: 'getting-started.md' },
  { pt: 'Worktrees gerenciadas', en: 'Managed worktrees', guide: 'worktrees.md' },
  { pt: 'Contexto ativo', en: 'Active context', guide: 'context.md' },
  { pt: 'Perfis de operação', en: 'Operating profiles', guide: 'operating-profiles.md' },
  { pt: 'Changes e verificação', en: 'Changes and verification', guide: 'changes-and-verification.md' },
  { pt: 'Memória compartilhada', en: 'Shared memory', guide: 'memory.md' },
  { pt: 'Sessões e importação', en: 'Sessions and import', guide: 'sessions-and-import.md' },
  { pt: 'Notas e conhecimento', en: 'Notes and knowledge', guide: 'notes-and-knowledge.md' },
  { pt: 'Custos e observabilidade', en: 'Costs and observability', guide: 'costs-and-observability.md' },
  { pt: 'Manutenção e diagnóstico', en: 'Maintenance and diagnostics', guide: 'maintenance-and-diagnostics.md' },
  { pt: 'Observer local', en: 'Local Observer', guide: 'observer.md' },
];
const DEEP_GUIDES = ['verify.md', 'memory-migration.md', 'retroactive-import.md'];
const GUIDE_FOR_FAMILY = new Map([
  ['wendkeep init', 'getting-started.md'], ['wendkeep sync', 'getting-started.md'],
  ['wendkeep worktree create', 'worktrees.md'], ['wendkeep worktree list', 'worktrees.md'],
  ['wendkeep worktree status', 'worktrees.md'], ['wendkeep worktree open', 'worktrees.md'],
  ['wendkeep context switch', 'context.md'], ['wendkeep context status', 'context.md'],
  ['wendkeep context recover', 'context.md'],
  ['wendkeep profile', 'operating-profiles.md'], ['wendkeep flow', 'operating-profiles.md'],
  ['wendkeep delivery', 'operating-profiles.md'],
  ['wendkeep hook', 'sessions-and-import.md'], ['wendkeep doctor', 'maintenance-and-diagnostics.md'],
  ['wendkeep change', 'changes-and-verification.md'], ['wendkeep theme sync', 'maintenance-and-diagnostics.md'],
  ['wendkeep session', 'sessions-and-import.md'], ['wendkeep spec', 'changes-and-verification.md'],
  ['wendkeep sensors', 'changes-and-verification.md'], ['wendkeep cost', 'costs-and-observability.md'],
  ['wendkeep cost rebuild', 'costs-and-observability.md'], ['wendkeep stats', 'costs-and-observability.md'],
  ['wendkeep import', 'sessions-and-import.md'], ['wendkeep verify', 'changes-and-verification.md'],
  ['wendkeep dashboard', 'notes-and-knowledge.md'], ['wendkeep renumber-decisions', 'notes-and-knowledge.md'],
  ['wendkeep renumber-bugs', 'notes-and-knowledge.md'], ['wendkeep renumber-learnings', 'notes-and-knowledge.md'],
  ['wendkeep note new', 'notes-and-knowledge.md'], ['wendkeep note relink', 'notes-and-knowledge.md'],
  ['wendkeep note repair-frontmatter', 'notes-and-knowledge.md'],
  ['wendkeep note repair-sections', 'notes-and-knowledge.md'], ['wendkeep lesson add', 'notes-and-knowledge.md'],
  ['wendkeep memory', 'memory.md'], ['wendkeep memory curate', 'memory.md'],
  ['wendkeep validate-memory', 'memory.md'],
  ['wendkeep sync-defs', 'maintenance-and-diagnostics.md'], ['wendkeep --version', 'maintenance-and-diagnostics.md'],
  ['wendkeep --help', 'maintenance-and-diagnostics.md'],
  ['wendkeep observer', 'observer.md'],
]);
const SEMANTIC_CONCEPTS = {
  'getting-started.md': { pt: [/instala/i, /atualiza/i, /vínculo|vincul/i], en: [/install/i, /updat/i, /bind/i] },
  'operating-profiles.md': { pt: [/perfil/i, /Keep Core/i, /microcontrato|FLOW/i], en: [/profile/i, /Keep Core/i, /microcontract|FLOW/i] },
  'changes-and-verification.md': { pt: [/change/i, /sensor/i, /evidência/i], en: [/change/i, /sensor/i, /evidence/i] },
  'memory.md': { pt: [/canônic/i, /operacional/i, /curadoria/i], en: [/canonical/i, /operational/i, /curation/i] },
  'sessions-and-import.md': { pt: [/sess/i, /registro|registry/i, /import/i], en: [/session/i, /registry/i, /import/i] },
  'notes-and-knowledge.md': { pt: [/nota/i, /renumer/i, /conhecimento/i], en: [/note/i, /renumber/i, /knowledge/i] },
  'costs-and-observability.md': { pt: [/custo/i, /tendência|projeção|trend/i, /históric/i], en: [/cost/i, /trend/i, /historical/i] },
  'maintenance-and-diagnostics.md': { pt: [/diagnóstic/i, /drift/i, /versão/i], en: [/diagnos/i, /drift/i, /version/i] },
  'verify.md': { pt: [/sensor/i, /evidência/i, /independente/i], en: [/sensor/i, /evidence/i, /independent/i] },
  'memory-migration.md': { pt: [/legad/i, /migra/i, /dry[- ]run/i], en: [/legacy/i, /migrat/i, /dry[- ]run/i] },
  'retroactive-import.md': { pt: [/retroativ/i, /deduplic|duplicata/i, /fork/i], en: [/retroactive/i, /deduplic|duplicate/i, /fork/i] },
  'observer.md': { pt: [/Observer/i, /snapshot/i, /outbox/i], en: [/Observer/i, /snapshot/i, /outbox/i] },
  'worktrees.md': { pt: [/worktree/i, /Vault/i, /registry/i], en: [/worktree/i, /Vault/i, /registry/i] },
  'context.md': { pt: [/contexto/i, /branch/i, /rollback|reversão/i], en: [/context/i, /branch/i, /rollback/i] },
};

const markdownLinks = (text) => [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);

function anchorFor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function assertLocalLinksResolve(sourcePath) {
  const source = readFileSync(sourcePath, 'utf8');
  for (const rawLink of markdownLinks(source)) {
    if (/^(?:https?:|mailto:)/i.test(rawLink)) continue;
    const [rawTarget, rawAnchor = ''] = rawLink.split('#', 2);
    const targetPath = rawTarget
      ? resolve(dirname(sourcePath), decodeURIComponent(rawTarget))
      : sourcePath;
    assert.ok(existsSync(targetPath), `${sourcePath}: link local ausente: ${rawLink}`);
    assert.ok(statSync(targetPath).isFile(), `${sourcePath}: link local não aponta para arquivo: ${rawLink}`);
    if (rawAnchor) {
      const target = readFileSync(targetPath, 'utf8');
      const anchors = [...target.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorFor(m[1]));
      assert.ok(anchors.includes(decodeURIComponent(rawAnchor)),
        `${sourcePath}: âncora local ausente: ${rawLink}`);
    }
  }
}

function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join('\n');
}

function normalizedCommandSurface(text, heading) {
  return section(text, heading)
    .split(/\r?\n/)
    .filter((line) => /\bwendkeep\b/.test(line))
    .map((line) => line.trim().replace(/^npx\s+/, '')
      .replace(/<[^>]+>/g, '<arg>')
      .replace(/"<[^"]+>"/g, '"<arg>"')
      .replace(/\[(?:opções|options|caminho-do-CORE|CORE-path)\]/gi, '[arg]'))
    .sort();
}

function assertReadmeGroups(text, locale) {
  const body = section(text, locale === 'pt' ? 'Funcionalidades por grupo' : 'Features by group');
  const rows = body.split(/\r?\n/).filter((line) => /^\| \*\*/.test(line));
  assert.equal(rows.length, README_GROUPS.length, `${locale}: quantidade de grupos divergente`);
  README_GROUPS.forEach((group, index) => {
    assert.match(rows[index], new RegExp(`\\*\\*${group[locale]}\\*\\*`), `${locale}: grupo ${index + 1}`);
    assert.ok(rows[index].includes(`/docs/${locale === 'pt' ? 'pt-BR' : 'en'}/commands/${group.guide}`),
      `${locale}: ${group[locale]} deve apontar para ${group.guide}`);
  });
  for (const guide of DEEP_GUIDES) assert.ok(body.includes(`/commands/${guide}`), `${locale}: guia profundo ${guide}`);
}

function helpFamilies() {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'wendkeep.mjs'), '--help'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return [...result.stdout.matchAll(/^\s{2}(wendkeep\s+.+?)\s{2,}/gm)].map((match) => {
    const usage = match[1].trim();
    if (/^wendkeep --(?:version|help)$/.test(usage)) return usage;
    const tokens = usage.split(/\s+/);
    const literals = [tokens.shift()];
    for (const token of tokens) {
      if (/^(?:--|\[|<|")/.test(token)) break;
      literals.push(token);
    }
    return literals.join(' ');
  });
}

function assertVerifyExitSemantics(text, locale) {
  const expectations = locale === 'pt'
    ? { 0: /todos os sensores[\s\S]*passaram[\s\S]*evidência foi gravada/i,
        1: /sensor crítico[\s\S]*(?:vermelho|mutante)/i,
        2: /uso\/contexto inválido[\s\S]*no change/i }
    : { 0: /all required sensors passed[\s\S]*evidence was written/i,
        1: /critical sensor[\s\S]*(?:red|mutant)/i,
        2: /invalid usage\/context[\s\S]*no change/i };
  for (const [code, meaning] of Object.entries(expectations)) {
    const line = text.match(new RegExp(`^\\- \\*\\*Exit ${code}:\\*\\*.*(?:\\r?\\n  .*|\\r?\\n    .*)*`, 'mi'))?.[0] ?? '';
    assert.match(line, meaning, `${locale}: exit ${code} mudou de significado`);
  }
}

test('DOC-2: PT-BR e EN têm exatamente os treze guias', () => {
  for (const dir of Object.values(GUIDE_DIR)) assert.ok(existsSync(dir), `diretório ausente: ${dir}`);
  const pt = readdirSync(GUIDE_DIR.pt).filter((f) => f.endsWith('.md')).sort();
  const en = readdirSync(GUIDE_DIR.en).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(pt, [...GUIDES].sort(), 'inventário PT-BR divergiu do contrato');
  assert.deepEqual(en, [...GUIDES].sort(), 'inventário EN divergiu do contrato');
  assert.deepEqual(pt, en, 'os diretórios de idiomas não estão espelhados');
});

test('DOC-2: cada par mantém estrutura editorial e alternador de idioma', () => {
  for (const guide of GUIDES) {
    const ptPath = join(GUIDE_DIR.pt, guide);
    const enPath = join(GUIDE_DIR.en, guide);
    const pt = readFileSync(ptPath, 'utf8');
    const en = readFileSync(enPath, 'utf8');
    for (const section of REQUIRED_SECTIONS.pt) assert.match(pt, new RegExp(`^## ${section}$`, 'm'), `${guide}: seção PT-BR ${section}`);
    for (const section of REQUIRED_SECTIONS.en) assert.match(en, new RegExp(`^## ${section}$`, 'm'), `${guide}: seção EN ${section}`);
    assert.match(pt, new RegExp(`\\.\\./\\.\\./en/commands/${guide.replace('.', '\\.')}`), `${guide}: link PT→EN`);
    assert.match(en, new RegExp(`\\.\\./\\.\\./pt-BR/commands/${guide.replace('.', '\\.')}`), `${guide}: link EN→PT-BR`);
    assert.deepEqual(normalizedCommandSurface(pt, 'Sintaxe'), normalizedCommandSurface(en, 'Syntax'),
      `${guide}: as superfícies de comando PT-BR/EN devem ser semanticamente equivalentes`);
    for (const locale of ['pt', 'en']) {
      for (const concept of SEMANTIC_CONCEPTS[guide][locale]) {
        assert.match(locale === 'pt' ? pt : en, concept, `${guide}: conceito ${locale} ausente: ${concept}`);
      }
    }
  }
});

test('DOC-1: READMEs preservam primeiro uso e navegam pelos treze guias do próprio idioma', () => {
  const pt = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const en = readFileSync(join(ROOT, 'README.en.md'), 'utf8');
  assert.match(pt, /^## Instalar & configurar$/m);
  assert.match(en, /^## Install & set up$/m);
  assert.match(pt, /^## Funcionalidades por grupo$/m);
  assert.match(en, /^## Features by group$/m);
  assertReadmeGroups(pt, 'pt');
  assertReadmeGroups(en, 'en');
  for (const guide of GUIDES) {
    assert.match(pt, new RegExp(`docs/pt-BR/commands/${guide.replace('.', '\\.')}`), `README PT-BR → ${guide}`);
    assert.match(en, new RegExp(`docs/en/commands/${guide.replace('.', '\\.')}`), `README EN → ${guide}`);
  }
  assert.doesNotMatch(pt, /docs\/en\/commands\//, 'README PT-BR não deve navegar para guias EN');
  assert.doesNotMatch(en, /docs\/pt-BR\/commands\//, 'README EN não deve navegar para guias PT-BR');
});

test('[req:OP-9] DOC-8: perfis, Keep Core e FLOW têm contrato público bilíngue equivalente', () => {
  const cases = {
    pt: {
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      guide: readFileSync(join(GUIDE_DIR.pt, 'operating-profiles.md'), 'utf8'),
      changes: readFileSync(join(GUIDE_DIR.pt, 'changes-and-verification.md'), 'utf8'),
      verify: readFileSync(join(GUIDE_DIR.pt, 'verify.md'), 'utf8'),
      sessions: readFileSync(join(GUIDE_DIR.pt, 'sessions-and-import.md'), 'utf8'),
      keepCore: /Keep Core[\s\S]*(?:sempre ativo|permanece ativo)/i,
      explicitOff: /OFF[\s\S]*(?:explicitamente|seleção explícita)/i,
      taskLease: /profile route[\s\S]*(?:solicitação atual|temporária|lease)/i,
      flowNoChange: /FLOW[\s\S]*(?:sem change|não cria[^\n]*change)/i,
      simpleCompat: /--simple[\s\S]*(?:não é|não equivale)[\s\S]*FLOW/i,
      vaultAlways: /OFF[\s\S]*(?:Vault|cofre)[\s\S]*(?:continua|permanece|ativo)/i,
    },
    en: {
      readme: readFileSync(join(ROOT, 'README.en.md'), 'utf8'),
      guide: readFileSync(join(GUIDE_DIR.en, 'operating-profiles.md'), 'utf8'),
      changes: readFileSync(join(GUIDE_DIR.en, 'changes-and-verification.md'), 'utf8'),
      verify: readFileSync(join(GUIDE_DIR.en, 'verify.md'), 'utf8'),
      sessions: readFileSync(join(GUIDE_DIR.en, 'sessions-and-import.md'), 'utf8'),
      keepCore: /Keep Core[\s\S]*(?:always active|remains active)/i,
      explicitOff: /OFF[\s\S]*(?:explicitly|explicit selection)/i,
      taskLease: /profile route[\s\S]*(?:current request|temporary|lease)/i,
      flowNoChange: /FLOW[\s\S]*(?:without a change|does not create[^\n]*change)/i,
      simpleCompat: /--simple[\s\S]*(?:is not|does not equal)[\s\S]*FLOW/i,
      vaultAlways: /OFF[\s\S]*Vault[\s\S]*(?:continues|remains|active)/i,
    },
  };

  for (const [locale, docs] of Object.entries(cases)) {
    for (const profile of ['OFF', 'FLOW', 'GUIDE', 'GOVERN', 'ASSURE']) {
      assert.match(docs.readme, new RegExp(`\\b${profile}\\b`), `${locale}: README sem ${profile}`);
      assert.match(docs.guide, new RegExp(`\\b${profile}\\b`), `${locale}: guia sem ${profile}`);
    }
    for (const command of [
      'wendkeep profile status', 'wendkeep profile use', 'wendkeep profile route',
      'wendkeep flow start', 'wendkeep flow status', 'wendkeep flow show',
      'wendkeep flow finish', 'wendkeep flow promote',
      'wendkeep delivery start', 'wendkeep delivery status',
      'wendkeep delivery finish', 'wendkeep delivery abandon',
    ]) assert.match(docs.guide, new RegExp(command), `${locale}: guia sem ${command}`);
    assert.match(docs.readme, docs.taskLease, `${locale}: README sem lease por solicitação`);
    assert.match(docs.guide, docs.taskLease, `${locale}: guia sem lease por solicitação`);

    assert.match(
      docs.guide,
      /\$flow\s*=\s*npx wendkeep flow start[^\n]*--json\s*\|\s*ConvertFrom-Json/i,
      `${locale}: exemplo FLOW não captura a resposta JSON de start`,
    );
    assert.match(
      docs.guide,
      /\$flowId\s*=\s*\$flow\.contract\.flow_id/i,
      `${locale}: exemplo FLOW não extrai flow_id do contrato retornado`,
    );
    assert.doesNotMatch(
      docs.guide,
      /\$flowId\s*=\s*\$flow\.flow_id/i,
      `${locale}: exemplo FLOW não pode procurar flow_id na raiz inexistente`,
    );
    assert.match(docs.guide, /wendkeep flow finish \$flowId/i, `${locale}: finish não reutiliza flow_id`);
    assert.match(docs.guide, /wendkeep flow promote \$flowId/i, `${locale}: promote não reutiliza flow_id`);
    assert.doesNotMatch(
      docs.guide,
      /wendkeep flow (?:finish|promote) (?:corrige-copy|fix-copy)/i,
      `${locale}: exemplo FLOW trata slug como flow_id`,
    );
    assert.match(
      docs.guide,
      /\.wendkeep\.json[\s\S]*harness[\s\S]*flow[\s\S]*protectedRoots/i,
      `${locale}: guia não documenta harness.flow.protectedRoots`,
    );
    assert.match(docs.readme, /harness\.flow\.protectedRoots/, `${locale}: README sem resumo de protectedRoots`);

    assert.match(docs.readme, docs.keepCore, `${locale}: README não promete Keep Core`);
    assert.match(docs.guide, docs.explicitOff, `${locale}: OFF não está explícito`);
    assert.match(docs.guide, docs.flowNoChange, `${locale}: FLOW não está separado de change`);
    assert.match(docs.guide, /allowlist/i, `${locale}: FLOW sem allowlist`);
    assert.match(docs.guide, /baseline Git|Git baseline/i, `${locale}: FLOW sem baseline Git`);
    assert.match(docs.guide, /sensor/i, `${locale}: FLOW sem sensor`);
    assert.match(docs.guide, /promov|promot/i, `${locale}: FLOW sem promoção`);
    assert.match(docs.guide, /(?:não existe|no)[^\n]*--force/i, `${locale}: FLOW permite --force`);
    assert.match(docs.changes, docs.simpleCompat, `${locale}: --simple confundido com FLOW`);
    assert.match(docs.verify, /flow finish/i, `${locale}: verify não encaminha FLOW`);
    assert.match(docs.sessions, docs.vaultAlways, `${locale}: sessões não garantem Vault em OFF`);
  }
});

test('DOC-3: verify documenta contexto, alternativas de saúde e exits 0/1/2', () => {
  for (const locale of ['pt', 'en']) {
    const text = readFileSync(join(GUIDE_DIR[locale], 'verify.md'), 'utf8');
    for (const token of ['--change', 'change use', 'verify --deep', 'doctor', 'memory status --gate']) {
      assert.match(text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${locale}: ${token}`);
    }
    for (const code of ['exit 0', 'exit 1', 'exit 2']) assert.match(text, new RegExp(code, 'i'), `${locale}: ${code}`);
    assert.match(text, /no change|sem change/i, `${locale}: ausência de change`);
    assertVerifyExitSemantics(text, locale);
  }
});

test('DOC-4: todas as famílias derivadas do help aparecem na sintaxe do guia correto', () => {
  const families = helpFamilies();
  assert.ok(families.length >= 28, 'o parser do help deve encontrar todas as famílias públicas');
  assert.equal(new Set(families).size, families.length, 'o help não deve produzir famílias duplicadas');
  for (const family of families) {
    const guide = GUIDE_FOR_FAMILY.get(family);
    assert.ok(guide, `família nova do --help sem guia designado: ${family}`);
    for (const [locale, dir] of Object.entries(GUIDE_DIR)) {
      const text = readFileSync(join(dir, guide), 'utf8');
      const syntax = normalizedCommandSurface(text, locale === 'pt' ? 'Sintaxe' : 'Syntax').join('\n');
      assert.ok(syntax.includes(family), `${locale}: sintaxe de ${guide} não cobre ${family}`);
      for (const heading of [
        locale === 'pt' ? 'Quando usar' : 'When to use',
        locale === 'pt' ? 'Resultado esperado' : 'Expected result',
        locale === 'pt' ? 'Erros comuns e diagnóstico' : 'Common errors and diagnosis',
      ]) assert.ok(section(text, heading).trim(), `${locale}: ${guide} não explica ${heading}`);
    }
  }
});

test('[req:ACTX-8] DOC-15: recovery documenta argumentos, candidatos, CAS e fail-closed nos dois idiomas', () => {
  const help = readFileSync(join(ROOT, 'packages', 'cli', 'src', 'index.mjs'), 'utf8');
  for (const token of ['context status', 'context recover', '--select', '--revision', '--reason']) {
    assert.match(help, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `help: ${token}`);
  }
  for (const [locale, dir] of Object.entries(GUIDE_DIR)) {
    const guide = readFileSync(join(dir, 'context.md'), 'utf8');
    const readme = readFileSync(join(ROOT, locale === 'pt' ? 'README.md' : 'README.en.md'), 'utf8');
    for (const token of [
      'context status', 'context recover', '--select', '--revision', '--reason',
      'reserved', 'observed', 'matches_actual', 'WENDKEEP_CONTEXT_CAS_MISMATCH',
    ]) assert.match(guide, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${locale} guide: ${token}`);
    for (const token of [
      'context status', 'context recover', '--select', '--revision', '--reason',
      'reserved', 'observed', 'CAS',
    ]) assert.match(readme, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${locale} README: ${token}`);
    assert.match(guide, /fail(?:-| )closed|falha[^\n]*sem writes|byte(?:-| )a(?:-| )byte/i, `${locale}: fail-closed`);
    assert.match(readme, /checkout/i, `${locale}: revalidation`);
  }
});

test('DOC-6: AGENTS exige atualização bilíngue somente fora do bloco gerenciado', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const managedEnd = agents.indexOf('<!-- wendkeep:skills:end -->');
  assert.ok(managedEnd >= 0, 'marcador final do bloco gerenciado ausente');
  const localRules = agents.slice(managedEnd);
  assert.match(localRules, /documenta/i);
  assert.match(localRules, /PT-BR/);
  assert.match(localRules, /EN|inglês/i);
  assert.match(localRules, /mesmo commit/i);
  assert.match(localRules, /comando|flag|código de saída|hook/i);
  assert.match(localRules, /não[\s\S]*(?:propag|consumidor)/i);
});

test('DOC-7: links Markdown locais resolvem para arquivos e âncoras existentes', () => {
  for (const file of ['README.md', 'README.en.md']) assertLocalLinksResolve(join(ROOT, file));
  for (const dir of Object.values(GUIDE_DIR)) {
    for (const guide of GUIDES) assertLocalLinksResolve(join(dir, guide));
  }
});

test('[req:OBS-13] DOC-10: rebuild documenta preview puro, apply causal, flags direcionadas e exits', () => {
  const cases = {
    pt: {
      text: readFileSync(join(GUIDE_DIR.pt, 'costs-and-observability.md'), 'utf8'),
      zeroWrite: /dry-run[\s\S]*zero escrita|dry-run[\s\S]*não (?:grava|escreve)[\s\S]*(?:nota|registry|runtime|relatório|lock)/i,
      applySafe: /--apply[\s\S]*(?:somente|apenas)[\s\S]*`complete`[\s\S]*`none`/i,
      preserve: /(?:`degraded`|`stale`)[\s\S]*exit `?1`?[\s\S]*(?:preserva|não altera)[\s\S]*nota/i,
      targeted: /(?:overrides|limites)[\s\S]*(?:exclusiv|somente)[\s\S]*--session/i,
      invalidUsage: /sem `?--session`?[\s\S]*exit `?2`?/i,
    },
    en: {
      text: readFileSync(join(GUIDE_DIR.en, 'costs-and-observability.md'), 'utf8'),
      zeroWrite: /dry-run[\s\S]*zero writes|dry-run[\s\S]*(?:does not|never) write[\s\S]*(?:note|registry|runtime|report|lock)/i,
      applySafe: /--apply[\s\S]*(?:only)[\s\S]*`complete`[\s\S]*`none`/i,
      preserve: /(?:`degraded`|`stale`)[\s\S]*exit `?1`?[\s\S]*(?:preserves|does not change)[\s\S]*note/i,
      targeted: /(?:overrides|limits)[\s\S]*(?:exclusiv|only)[\s\S]*--session/i,
      invalidUsage: /without `?--session`?[\s\S]*exit `?2`?/i,
    },
  };
  const flags = ['--max-graph-nodes', '--max-fallback-days', '--max-fallback-candidates'];
  for (const [locale, contract] of Object.entries(cases)) {
    for (const flag of flags) assert.match(contract.text, new RegExp(flag), `${locale}: flag ausente ${flag}`);
    for (const key of ['zeroWrite', 'applySafe', 'preserve', 'targeted', 'invalidUsage']) {
      assert.match(contract.text, contract[key], `${locale}: contrato rebuild ausente: ${key}`);
    }
  }
});

test('[req:OBS-11] [req:OBS-12] [req:IMPORT-5] DOC-11: hooks e import têm contrato causal bilíngue', () => {
  const cases = {
    pt: {
      text: readFileSync(join(GUIDE_DIR.pt, 'sessions-and-import.md'), 'utf8'),
      reconcile: /import[\s\S]*reconcilia[\s\S]*observabilidade[\s\S]*(?:mesmo|ainda que)[\s\S]*(?:nenhum `wk-turn`|sem `wk-turn`)[\s\S]*(?:ausente|faltando)/i,
      coalesce: /SubagentStop[\s\S]*250\s*ms[\s\S]*(?:coalesc|agrup)/i,
    },
    en: {
      text: readFileSync(join(GUIDE_DIR.en, 'sessions-and-import.md'), 'utf8'),
      reconcile: /import[\s\S]*reconcile[\s\S]*observability[\s\S]*(?:even|although)[\s\S]*no `wk-turn`[\s\S]*(?:missing|absent)/i,
      coalesce: /SubagentStop[\s\S]*250\s*ms[\s\S]*(?:coalesc|batch)/i,
    },
  };
  for (const [locale, contract] of Object.entries(cases)) {
    assert.match(contract.text, /Stop[^\n]*45\s*s/i, `${locale}: deadline Stop 45 s`);
    assert.match(contract.text, /SubagentStop[^\n]*15\s*s/i, `${locale}: deadline SubagentStop 15 s`);
    assert.match(contract.text, contract.coalesce, `${locale}: coalescência SubagentStop`);
    assert.match(contract.text, contract.reconcile, `${locale}: reconciliação sem turno faltante`);
    for (const state of ['complete', 'none', 'degraded']) {
      assert.match(contract.text, new RegExp(`\\b${state}\\b`), `${locale}: estado ${state}`);
    }
  }
});

test('[req:DIAG-9] DOC-12: doctor distingue frescor e recomenda dry-run antes de apply', () => {
  const cases = {
    pt: readFileSync(join(GUIDE_DIR.pt, 'maintenance-and-diagnostics.md'), 'utf8'),
    en: readFileSync(join(GUIDE_DIR.en, 'maintenance-and-diagnostics.md'), 'utf8'),
  };
  for (const [locale, text] of Object.entries(cases)) {
    for (const state of ['legacy', 'degraded', 'stale', 'manifest-unproven', 'none', 'complete']) {
      assert.match(text, new RegExp(`\\b${state}\\b`), `${locale}: doctor sem estado ${state}`);
    }
    assert.match(text, /(?:`none`|`complete`)[\s\S]*(?:fresc|fresh)/i, `${locale}: estado saudável sem frescor`);
    assert.match(text, /npx --no-install wendkeep cost rebuild --session <id> --json --vault \S+[\s\S]*npx --no-install wendkeep cost rebuild --session <id> --json --vault \S+ --apply/i,
      `${locale}: doctor não recomenda dry-run antes de apply`);
    assert.match(text, /doctor[\s\S]*(?:read-only|somente leitura)/i, `${locale}: doctor não é read-only`);
  }
});

test('[req:OBS-11] [req:OBS-12] DOC-13: READMEs resumem observabilidade e delegam detalhes aos guias', () => {
  const cases = {
    pt: {
      text: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      summary: /Custos e observabilidade[^\n]*(?:dry-run)[^\n]*(?:tri-state|complete|degraded)/i,
      sessions: /Sessões e importação[^\n]*(?:hooks causais|reconciliação)/i,
      doctor: /Manutenção e diagnóstico[^\n]*(?:frescor|frontier|manifest)/i,
    },
    en: {
      text: readFileSync(join(ROOT, 'README.en.md'), 'utf8'),
      summary: /Costs and observability[^\n]*(?:dry-run)[^\n]*(?:tri-state|complete|degraded)/i,
      sessions: /Sessions and import[^\n]*(?:causal hooks|reconciliation)/i,
      doctor: /Maintenance and diagnostics[^\n]*(?:freshness|frontier|manifest)/i,
    },
  };
  for (const [locale, contract] of Object.entries(cases)) {
    assert.match(contract.text, contract.summary, `${locale}: resumo de rebuild/tri-state`);
    assert.match(contract.text, contract.sessions, `${locale}: resumo de hooks/import`);
    assert.match(contract.text, contract.doctor, `${locale}: resumo de doctor/frescor`);
  }
});

test('[req:MEM-CUR-4] [req:MEM-CUR-5] [req:MEM-CUR-6] [req:DIAG-8] [req:DIAG-11] DOC-14: curadoria guiada e doctor humano são públicos e bilíngues', () => {
  const help = spawnSync(process.execPath, [join(ROOT, 'bin', 'wendkeep.mjs'), '--help'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /memory <sub>[\s\S]*candidates \[--active\]/i);
  assert.match(help.stdout, /memory curate/i);

  const cases = {
    pt: {
      memory: readFileSync(join(GUIDE_DIR.pt, 'memory.md'), 'utf8'),
      doctor: readFileSync(join(GUIDE_DIR.pt, 'maintenance-and-diagnostics.md'), 'utf8'),
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      repairBoundary: /memory repair[\s\S]*não escolhe vencedor/i,
      noValues: /não (?:expõe|inclui)[^\n]*(?:valores|conteúdo)/i,
      confirmation: /confirmação[\s\S]*(?:padrão|default)[^\n]*(?:não|negativ)/i,
      resume: /(?:pular|sair)[\s\S]*(?:retom|restant)/i,
      humanDoctor: /doctor[\s\S]*(?:formato|saída)[^\n]*human/i,
      ttyFallback: /(?:não-TTY|sem TTY|terminal não interativo)[\s\S]*memory candidates --active/i,
      exceptionalHealth: /Vault ausente[\s\S]*(?:boundary|registry)[\s\S]*JSON\s+estruturado/i,
    },
    en: {
      memory: readFileSync(join(GUIDE_DIR.en, 'memory.md'), 'utf8'),
      doctor: readFileSync(join(GUIDE_DIR.en, 'maintenance-and-diagnostics.md'), 'utf8'),
      readme: readFileSync(join(ROOT, 'README.en.md'), 'utf8'),
      repairBoundary: /memory repair[\s\S]*(?:does not|never) choose[^\n]*winner/i,
      noValues: /does not (?:expose|include)[^\n]*(?:values|content)/i,
      confirmation: /confirmation[\s\S]*default[^\n]*no/i,
      resume: /(?:skip|quit)[\s\S]*resum/i,
      humanDoctor: /doctor[\s\S]*human[^\n]*(?:format|output)/i,
      ttyFallback: /non-TTY[\s\S]*memory candidates --active/i,
      exceptionalHealth: /missing Vault[\s\S]*(?:boundary|registry)[\s\S]*structured\s+JSON/i,
    },
  };
  for (const [locale, docs] of Object.entries(cases)) {
    for (const text of [docs.memory, docs.doctor, docs.readme]) {
      assert.match(text, /memory candidates --active/i, `${locale}: superfície candidates ausente`);
      assert.match(text, /memory curate/i, `${locale}: assistente de curadoria ausente`);
    }
    for (const field of ['candidate_id', 'reason', 'status', 'memory_key', 'event_ids']) {
      assert.match(docs.memory, new RegExp(field), `${locale}: campo seguro ausente ${field}`);
    }
    assert.match(docs.memory, docs.noValues, `${locale}: limite de privacidade ausente`);
    assert.match(docs.memory, docs.confirmation, `${locale}: confirmação default-no ausente`);
    assert.match(docs.memory, docs.resume, `${locale}: retomada após pular/sair ausente`);
    assert.match(docs.memory, docs.ttyFallback, `${locale}: fallback não-TTY ausente`);
    assert.match(docs.doctor, docs.repairBoundary, `${locale}: fronteira repair/curadoria ausente`);
    assert.match(docs.doctor, docs.humanDoctor, `${locale}: saída humana do doctor ausente`);
    assert.match(docs.doctor, docs.exceptionalHealth, `${locale}: exceções não preservam o contrato do doctor/hook`);
    assert.match(docs.readme, docs.exceptionalHealth, `${locale}: README omite o contrato excepcional do doctor/hook`);
    assert.match(docs.memory, /memory promote <candidate-id> --event <event-id>/i);
    assert.match(docs.memory, /memory reject <candidate-id>/i);
  }
});

test('[req:ACTX-12] [req:ACTX-13] DOC-16: registry multi-contexto e migração conservadora são bilíngues', () => {
  const cases = {
    pt: {
      guide: readFileSync(join(GUIDE_DIR.pt, 'context.md'), 'utf8'),
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      projection: /CURRENT_CHANGE\.md[\s\S]*(?:projeção|derivad)[\s\S]*(?:único|inequívoc)/i,
      migration: /migra[çc][aã]o[\s\S]*(?:não inventa|sem inventar)[\s\S]*(?:identidade|worktree|sessão)/i,
      ambiguity: /duas sessões[\s\S]*(?:ambiguidade|falha fechado|falha fechada)/i,
    },
    en: {
      guide: readFileSync(join(GUIDE_DIR.en, 'context.md'), 'utf8'),
      readme: readFileSync(join(ROOT, 'README.en.md'), 'utf8'),
      projection: /CURRENT_CHANGE\.md[\s\S]*(?:projection|derived)[\s\S]*(?:single|unambiguous)/i,
      migration: /migration[\s\S]*(?:does not|never)[\s\S]*invent[\s\S]*(?:identity|worktree|session)/i,
      ambiguity: /two sessions[\s\S]*(?:ambiguity|fail closed)/i,
    },
  };
  for (const [locale, docs] of Object.entries(cases)) {
    for (const text of [docs.guide, docs.readme]) {
      assert.match(text, /active_contexts/i, `${locale}: schema ausente`);
      for (const field of ['repository_id', 'worktree_id', 'work_session_id']) {
        assert.match(text, new RegExp(field), `${locale}: identidade ausente ${field}`);
      }
    }
    assert.match(docs.guide, docs.projection, `${locale}: limite da projeção legada ausente`);
    assert.match(docs.guide, docs.migration, `${locale}: migração conservadora ausente`);
    assert.match(docs.guide, docs.ambiguity, `${locale}: ambiguidade causal ausente`);
  }
});
