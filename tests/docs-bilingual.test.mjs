// DOC-1..DOC-7 — the public CLI documentation is a bilingual, navigable package surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = [
  'getting-started.md',
  'changes-and-verification.md',
  'memory.md',
  'sessions-and-import.md',
  'notes-and-knowledge.md',
  'costs-and-observability.md',
  'maintenance-and-diagnostics.md',
  'verify.md',
  'memory-migration.md',
  'retroactive-import.md',
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
  { pt: 'Changes e verificação', en: 'Changes and verification', guide: 'changes-and-verification.md' },
  { pt: 'Memória compartilhada', en: 'Shared memory', guide: 'memory.md' },
  { pt: 'Sessões e importação', en: 'Sessions and import', guide: 'sessions-and-import.md' },
  { pt: 'Notas e conhecimento', en: 'Notes and knowledge', guide: 'notes-and-knowledge.md' },
  { pt: 'Custos e observabilidade', en: 'Costs and observability', guide: 'costs-and-observability.md' },
  { pt: 'Manutenção e diagnóstico', en: 'Maintenance and diagnostics', guide: 'maintenance-and-diagnostics.md' },
];
const DEEP_GUIDES = ['verify.md', 'memory-migration.md', 'retroactive-import.md'];
const GUIDE_FOR_FAMILY = new Map([
  ['wendkeep init', 'getting-started.md'], ['wendkeep sync', 'getting-started.md'],
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
  ['wendkeep memory', 'memory.md'], ['wendkeep validate-memory', 'memory.md'],
  ['wendkeep sync-defs', 'maintenance-and-diagnostics.md'], ['wendkeep --version', 'maintenance-and-diagnostics.md'],
  ['wendkeep --help', 'maintenance-and-diagnostics.md'],
]);
const SEMANTIC_CONCEPTS = {
  'getting-started.md': { pt: [/instala/i, /atualiza/i, /vínculo|vincul/i], en: [/install/i, /updat/i, /bind/i] },
  'changes-and-verification.md': { pt: [/change/i, /sensor/i, /evidência/i], en: [/change/i, /sensor/i, /evidence/i] },
  'memory.md': { pt: [/canônic/i, /operacional/i, /curadoria/i], en: [/canonical/i, /operational/i, /curation/i] },
  'sessions-and-import.md': { pt: [/sess/i, /registro|registry/i, /import/i], en: [/session/i, /registry/i, /import/i] },
  'notes-and-knowledge.md': { pt: [/nota/i, /renumer/i, /conhecimento/i], en: [/note/i, /renumber/i, /knowledge/i] },
  'costs-and-observability.md': { pt: [/custo/i, /tendência|projeção|trend/i, /históric/i], en: [/cost/i, /trend/i, /historical/i] },
  'maintenance-and-diagnostics.md': { pt: [/diagnóstic/i, /drift/i, /versão/i], en: [/diagnos/i, /drift/i, /version/i] },
  'verify.md': { pt: [/sensor/i, /evidência/i, /independente/i], en: [/sensor/i, /evidence/i, /independent/i] },
  'memory-migration.md': { pt: [/legad/i, /migra/i, /dry[- ]run/i], en: [/legacy/i, /migrat/i, /dry[- ]run/i] },
  'retroactive-import.md': { pt: [/retroativ/i, /deduplic|duplicata/i, /fork/i], en: [/retroactive/i, /deduplic|duplicate/i, /fork/i] },
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
  assert.equal(rows.length, README_GROUPS.length, `${locale}: deve haver exatamente sete grupos`);
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

test('DOC-2: PT-BR e EN têm exatamente os mesmos dez guias', () => {
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

test('DOC-1: READMEs preservam primeiro uso e navegam pelos dez guias do próprio idioma', () => {
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
