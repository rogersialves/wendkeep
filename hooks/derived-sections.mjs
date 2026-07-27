// As três seções derivadas do corpo da nota de sessão: Decisões, Bugs e Aprendizados.
//
// Até a 0.52.0 ninguém escrevia nas seções de bug e aprendizado, e a de decisões só recebia
// os ADRs capturados via AskUserQuestion — um ADR gerado por `change archive` aparecia no
// Encerramento e nunca no corpo. Num vault real: 15 decisões e 5 aprendizados no
// Encerramento contra 3 decisões e um placeholder no corpo.
//
// O fecho (finalizeSessionFile) e o reparo retroativo (repairDerivedSections) usam as MESMAS
// funções daqui. Foi a lição do note repair-frontmatter: quando reparo e comportamento
// corrente divergem, o doctor passa a acusar o que o reparo não conserta.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getLocale } from './locale.mjs';
import { mutateSessionNote } from './session-note-io.mjs';
import { toVaultRelative, wikilinkFromRel } from './obsidian-common.mjs';

export const DERIVED_SECTIONS = [
  { key: 'decisions', heading: 'Decisões geradas nesta sessão', folderKey: 'decisions' },
  { key: 'bugs', heading: 'Bugs gerados nesta sessão', folderKey: 'bugs' },
  { key: 'learnings', heading: 'Aprendizados gerados nesta sessão', folderKey: 'learnings' },
];

// Ordena pelo caminho: agrupa por tipo e deixa a numeração (ADR-0003, ADR-0005, …) em ordem.
// O Encerramento herda a ordem de varredura do filesystem, que não é garantida.
export function derivedSectionLines(items) {
  return [...new Set(items || [])].sort().map((rel) => `- ${wikilinkFromRel(rel)}`);
}

// Aplica as três seções ao conteúdo. Fecho e reparo passam por aqui — se cada um tivesse
// seu upsert, voltariam a divergir (a lição do note repair-frontmatter).
export function applyDerivedSections(content, created) {
  let next = content;
  for (const { key, heading } of DERIVED_SECTIONS) {
    // Lista vazia devolve o conteúdo intocado, então a seção sem itens mantém o
    // placeholder — seção vazia é informação ("não gerou aprendizado"), não defeito.
    next = defaultUpsert(next, heading, derivedSectionLines(created?.[key]));
  }
  return next;
}

const SESSION_LINK = /\[\[((?:02-Sess|02-Session)[^\]|]+)/g;

// A sessão que GEROU a nota, não toda sessão que a nota cita.
//
// `findLinkedDerivedNotes` casa por substring no arquivo inteiro, então uma derivada que
// menciona outra sessão em `related:` ou na prosa é atribuída às duas. Caso real neste
// vault: BUG-0001 declara `session:` de uma sessão e `source:`/`related:` de outra, e a
// varredura devolve a nota para ambas. No Encerramento o erro é regenerado a cada reopen;
// escrito no corpo ele fica. Por isso a proveniência declarada manda quando existe.
export function provenanceSessions(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const scope = fm ? fm[1] : content;
  // `source:` é o campo de proveniência canônico do vault — é o que `note relink` faz
  // backfill (DRV-9). Só quando ele falta (nota legada) caímos para qualquer referência.
  const source = scope.match(/^source:\n((?:\s+- .*\n?)+)/m) || scope.match(/^source:\s*(.+)$/m);
  const hay = source ? source[1] : content;
  const found = new Set();
  for (const m of hay.matchAll(SESSION_LINK)) found.add(m[1].trim());
  return [...found];
}

// Lê as notas derivadas UMA vez e indexa por sessão referenciada. O fecho pode varrer por
// sessão (uma só, custo irrelevante); o reparo percorre N sessões e pagaria O(N*M) leituras.
export function indexDerivedBySession(vaultBase) {
  const folders = getLocale(vaultBase).folders;
  const index = new Map(); // sessão (rel, sem .md) -> { decisions:[], bugs:[], learnings:[] }

  const record = (sessionKey, key, rel) => {
    if (!index.has(sessionKey)) index.set(sessionKey, { decisions: [], bugs: [], learnings: [] });
    index.get(sessionKey)[key].push(rel);
  };

  for (const { key, folderKey } of DERIVED_SECTIONS) {
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        if (!entry.name.endsWith('.md')) continue;
        let content;
        try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
        const rel = toVaultRelative(vaultBase, abs);
        for (const target of provenanceSessions(content)) record(target, key, rel);
      }
    };
    walk(join(vaultBase, folders[folderKey]));
  }
  return index;
}

const SESSIONS_DIR_CANDIDATES = ['02-Sessões', '02-Sessions'];

export function listSessionNotes(vaultBase) {
  const out = [];
  for (const dirName of SESSIONS_DIR_CANDIDATES) {
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        if (entry.name.endsWith('.md')) out.push(abs);
      }
    };
    walk(join(vaultBase, dirName));
  }
  return out;
}

// Localizador ÚNICO da seção — detector e reparador passam por aqui.
//
// Um heading Markdown começa em coluna zero; casar `## X` como substring solta encontra
// qualquer menção em prosa. A nota de sessão é justamente o lugar onde isso acontece: ela
// transcreve a conversa, e uma conversa SOBRE as seções cita os nomes delas. Foi assim que
// o detector passou a acusar links faltando que estavam presentes na seção verdadeira,
// enquanto o reparo (que já usava o marcador ancorado) não achava nada a fazer.
export function findSectionBounds(content, heading) {
  const marker = `\n## ${heading}\n`;
  const start = content.indexOf(marker);
  if (start === -1) return null;
  const bodyStart = start + marker.length;
  const nextRel = content.slice(bodyStart).search(/\n## /);
  return { start, bodyStart, bodyEnd: nextRel === -1 ? content.length : bodyStart + nextRel };
}

const sectionBody = (content, heading) => {
  const at = findSectionBounds(content, heading);
  return at ? content.slice(at.start, at.bodyEnd) : null;
};

// O que a nota DEVERIA listar mas não lista. Excedente (link posto à mão) não é sintoma
// deste bug e não é reportado — pode ser curadoria do dono do vault.
export function missingDerivedLinks(content, entry) {
  const missing = { decisions: [], bugs: [], learnings: [] };
  for (const { key, heading } of DERIVED_SECTIONS) {
    const body = sectionBody(content, heading);
    if (body === null) continue;
    for (const rel of entry?.[key] || []) {
      const link = wikilinkFromRel(rel);
      if (!body.includes(link) && !body.includes(rel)) missing[key].push(rel);
    }
  }
  return missing;
}

export const countMissing = (missing) =>
  DERIVED_SECTIONS.reduce((n, { key }) => n + (missing[key]?.length || 0), 0);

// Junta o que a seção já lista com o que o índice conhece, para que o reparo seja aditivo:
// um link posto à mão sobrevive ao conserto.
function mergedForNote(entry) {
  return {
    decisions: entry?.decisions || [],
    bugs: entry?.bugs || [],
    learnings: entry?.learnings || [],
  };
}

export function repairDerivedSections(vaultBase, { apply = false, lockTimeoutMs } = {}) {
  const index = indexDerivedBySession(vaultBase);
  const repaired = [];
  const skipped = [];

  for (const abs of listSessionNotes(vaultBase)) {
    const rel = relative(vaultBase, abs).replaceAll('\\', '/');
    const entry = index.get(rel.replace(/\.md$/, '')) || index.get(rel);
    if (!entry) continue;

    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { skipped.push({ file: rel, reason: 'leitura falhou' }); continue; }

    const missing = countMissing(missingDerivedLinks(content, entry));
    if (!missing) continue;

    if (!apply) { repaired.push({ file: rel, missing }); continue; }

    const outcome = mutateSessionNote(
      abs,
      (original) => applyDerivedSections(original, mergedForNote(entry)),
      { ...(lockTimeoutMs ? { timeoutMs: lockTimeoutMs } : {}), vaultBase },
    );
    if (!outcome.written) { skipped.push({ file: rel, reason: `gravação não ocorreu (${outcome.reason})` }); continue; }
    repaired.push({ file: rel, missing });
  }

  return { applied: apply, repaired, skipped };
}

// O placeholder do template ("Nenhuma decisão registrada ainda.") não começa com `- `, então
// o filtro de lista já o descarta. Mas a variante COM bullet passaria no filtro e viveria
// para sempre junto dos links reais — é o mesmo caso que `shouldDropFileListLine` já cobre
// defensivamente nas seções de arquivos.
export const isDerivedPlaceholder = (line) => /^-?\s*Nenhum[ao]?\s+\S+.*registrad[ao]s?\s+ainda\.?$/i.test(line.trim());

// Upsert próprio (o reparo não pode depender do hook de Stop, que carrega transcript, locale
// e o mundo). Duas diferenças deliberadas em relação ao upsertListSection do session-stop:
// descarta o placeholder em qualquer variante, e PRESERVA prosa — uma nota que o dono do
// vault escreveu na seção não pode sumir num conserto automático.
function defaultUpsert(content, heading, lines) {
  if (!lines.length) return content;
  const at = findSectionBounds(content, heading);
  if (!at) return content; // heading ausente: nunca inventa seção em nota alheia
  const { bodyStart, bodyEnd } = at;

  const prose = [];
  const items = [];
  const add = (line) => { if (!items.includes(line)) items.push(line); };
  for (const raw of content.slice(bodyStart, bodyEnd).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || isDerivedPlaceholder(line)) continue;
    if (line.startsWith('- ')) add(line);
    else prose.push(line); // comentário do agente/dono do vault: sobrevive ao conserto
  }
  for (const line of lines) add(line);

  const body = [...prose, ...(prose.length ? [''] : []), ...items].join('\n');
  return `${content.slice(0, bodyStart)}\n${body}\n\n${content.slice(bodyEnd).replace(/^\n+/, '')}`;
}
