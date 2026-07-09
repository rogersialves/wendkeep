#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import {
  monthFolderRelFromDateStr,
  derivedContentKey,
  ensureDir,
  getNextAdrNumber,
  keysBate,
  providerMeta,
  slugify,
  toVaultRelative,
  wikilinkFromRel,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';
import { captureProseDecisions } from './decision-capture.mjs';

function yamlQuote(value) {
  return `"${String(value || '').replaceAll('"', '\\"')}"`;
}

function uniqueTags(tags) {
  return [...new Set(tags.filter(Boolean).map((tag) => slugify(tag, 'tag')))];
}

function assistantText(tx) {
  return (tx.assistantMessages || []).join('\n');
}

function firstUserPrompt(tx) {
  return (tx.userPrompts || [])[0] || tx.latestUserPrompt || '';
}

function normalizeInline(text, max = 0) {
  const clean = String(text || '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return max && clean.length > max ? `${clean.slice(0, max).trim()}...` : clean;
}

function adrFileExistsBySlug(dir, slug) {
  try {
    return readdirSync(dir).find((file) => /^ADR-\d+-.+\.md$/i.test(file) && file.includes(`-${slug}`));
  } catch {
    return '';
  }
}

function markdownList(items, fallback) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : fallback;
}

function yamlTags(tags) {
  return uniqueTags(tags).map((tag) => `  - ${tag}`).join('\n');
}

function sessionYamlLinks(sessionRel) {
  const link = wikilinkFromRel(sessionRel);
  return [
    'source:',
    `  - ${yamlQuote(link)}`,
    'related:',
    `  - ${yamlQuote(link)}`,
  ].join('\n');
}

function extractIssueRefs(tx) {
  const text = [
    assistantText(tx),
    firstUserPrompt(tx),
    tx.rawTextForDetection || '',
  ].join('\n');
  return [...new Set((text.match(/\bNUT-\d+\b/gi) || []).map((ref) => ref.toUpperCase()))];
}

export function extractBugDetails(tx) {
  const allContent = assistantText(tx);
  const hasFixCommit = (tx.assistantMessages || []).some((message) => /git commit[^\"]*"fix\(/i.test(message));
  const hasFixMention = /(?:commit|commitar)[\s:*]*`?fix\(/i.test(allContent);
  const hasFixPattern = /\*\*Fix\s+\d+\s*[—–-]/i.test(allContent);
  const hasRootCause = /\*?\*?(?:causa[- ]?raiz|root cause)\*?\*?\s*:/i.test(allContent);

  if (!hasFixCommit && !(hasFixMention && hasRootCause) && !(hasFixPattern && hasRootCause)) return null;

  let match;
  let rootCause = '';
  const rootCauses = [];
  const rootCausePattern = /\*?\*?(?:causa[- ]?raiz|root cause)\*?\*?[:\s]+(.{30,500}?)(?:\.\s|\n\n|\n\*\*|$)/gim;
  while ((match = rootCausePattern.exec(allContent)) !== null) {
    const text = normalizeInline(match[1]);
    if (text.length > 20) rootCauses.push(text);
  }
  if (rootCauses.length > 0) rootCause = rootCauses.sort((a, b) => b.length - a.length)[0];

  const bugPrompt = (tx.userPrompts || []).find((prompt) =>
    /NUT-\d+|bug|erro|problema|não funciona|falha|corrigir|fix\b/i.test(prompt)
  );
  const symptom = bugPrompt ? normalizeInline(bugPrompt, 300) : '';

  const fixes = [];
  const fixPattern = /\*\*Fix\s+\d+\s*[—–-]\s*(\w+)\*\*[^:]*:\s*(.{20,300}?)(?:\.\s|\n\n|$)/gim;
  while ((match = fixPattern.exec(allContent)) !== null) {
    fixes.push(`**${match[1]}:** ${normalizeInline(match[2])}`);
  }

  for (const message of tx.assistantMessages || []) {
    const commits = message.match(/git commit[^\"]*"(fix\([^\"]+)"/gi);
    if (!commits) continue;
    for (const commit of commits) {
      const commitMatch = commit.match(/"(fix\([^\"]+)"/i);
      if (commitMatch) fixes.push(`Commit: \`${commitMatch[1]}\``);
    }
  }

  const correctionPattern = /(?:corre[çc][ãa]o|a\s+corre[çc][ãa]o\s+(?:foi|é))\s*[:\s]+(.{20,300}?)(?:\n\n|$)/gim;
  while ((match = correctionPattern.exec(allContent)) !== null) {
    const text = normalizeInline(match[1]);
    if (!fixes.some((fix) => fix.includes(text.slice(0, 30)))) fixes.push(text);
  }

  const fileSet = new Set();
  for (const file of [...(tx.changedFiles || []), ...(tx.editedFiles || [])]) {
    const rel = String(file).replace(/^.*?(?=backend-core|mobile-app|ngv-admin|vision-|\.\.)/i, '');
    if (rel) fileSet.add(rel);
  }
  const pathPattern = /`((?:backend-core|mobile-app|ngv-admin-api|vision-food|vision-gym|\.?\.?\/?)[^\s`]+\.(?:py|ts|tsx|js|jsx|sql|md|mjs))`/g;
  while ((match = pathPattern.exec(allContent)) !== null) fileSet.add(match[1]);

  const evidence = [];
  const testMatch = allContent.match(/(\d+)\s+(?:passed|tests?\s+pass)/i);
  const failMatch = allContent.match(/(\d+)\s+(?:failures?|failed)/i);
  if (testMatch) evidence.push(`Testes: ${testMatch[1]} passed, ${failMatch ? failMatch[1] : '0'} failures`);
  if (/deploy\s+(?:concluído|realizado|com\s+sucesso)/i.test(allContent)) evidence.push('Deploy realizado com sucesso');
  const migrationMatch = allContent.match(/(?:migra[çc][ãa]o|alembic\s+upgrade)\s+(\S+)/i);
  if (migrationMatch) evidence.push(`Migração aplicada: ${migrationMatch[1]}`);
  const httpMatch = allContent.match(/(?:status|HTTP|health)[:\s]*(\d{3})\s*(?:OK)?/i);
  if (httpMatch) evidence.push(`HTTP ${httpMatch[1]} OK`);

  let lessons = '';
  const lessonMatch = allContent.match(/(?:li[çc][ãa]o|aprendizado|lesson|sempre)\s*(?:aprendida|learned)?[:\s]+(.{20,300}?)(?:\.\s|\n\n|$)/i);
  if (lessonMatch) lessons = normalizeInline(lessonMatch[1]);

  const lc = allContent.toLowerCase();
  let severity = 'média';
  if (/produ[çc][ãa]o|vps|deploy|billing|payment|data.?loss|race.?condition|security/.test(lc)) severity = 'alta';
  else if (/ui|visual|layout|estilo|css|\bcor\b/.test(lc)) severity = 'baixa';

  const tags = ['bug', 'codex', 'obsidian'];
  if (/stripe|billing|payment|subscription/i.test(lc)) tags.push('stripe', 'billing');
  if (/celery|worker|task|queue/i.test(lc)) tags.push('celery');
  if (/alembic|migra[çc]|database|postgres/i.test(lc)) tags.push('database');
  if (/react.?native|expo|mobile/i.test(lc)) tags.push('mobile');
  if (/fastapi|backend|endpoint|api/i.test(lc)) tags.push('backend');
  if (/race.?condition|concurrent|deadlock/i.test(lc)) tags.push('concurrency');

  return {
    symptom,
    rootCause: rootCause || '_Causa raiz não identificada automaticamente._',
    fixes,
    changedFiles: [...fileSet].sort(),
    evidence,
    lessons: lessons || '_Revisar e complementar._',
    severity,
    tags: uniqueTags(tags),
  };
}

// Locale labels for the auto-generated derived notes (0.9.0). Output-only — the extraction
// heuristics are untouched. Default pt-BR keeps existing behaviour for every legacy caller.
const NOTE_LABELS = {
  'pt-BR': {
    autoTag: 'Auto-gerada', autoLine: (p) => `Nota criada automaticamente pelo hook Stop do ${p}.`, session: 'Sessão',
    verify: '_Extraído da sessão — verificar._', complete: '_Extraído da sessão — complementar._',
    bug: { symptom: 'Sintoma', rootCause: 'Causa raiz', fix: 'Correção', files: 'Arquivos alterados', evidence: 'Evidência', lessons: 'Lições aprendidas', noFix: '_Nenhuma correção explícita detectada._', seeSession: '_Ver sessão vinculada._', addEvidence: '_Adicionar evidência empírica._' },
    dec: { context: 'Contexto', decision: 'Decisão', consequences: 'Consequências', alternatives: 'Alternativas consideradas', noAlt: '_Nenhuma alternativa registrada automaticamente._' },
    learn: { title: 'Aprendizado', context: 'Contexto', learned: 'O que aprendemos', future: 'Como aplicar no futuro', futureHint: '_Registrar como este conhecimento pode ser reutilizado._' },
  },
  en: {
    autoTag: 'Auto-generated', autoLine: (p) => `Note created automatically by the ${p} Stop hook.`, session: 'Session',
    verify: '_Extracted from the session — verify._', complete: '_Extracted from the session — complete._',
    bug: { symptom: 'Symptom', rootCause: 'Root cause', fix: 'Fix', files: 'Changed files', evidence: 'Evidence', lessons: 'Lessons learned', noFix: '_No explicit fix detected._', seeSession: '_See the linked session._', addEvidence: '_Add empirical evidence._' },
    dec: { context: 'Context', decision: 'Decision', consequences: 'Consequences', alternatives: 'Alternatives considered', noAlt: '_No alternative recorded automatically._' },
    learn: { title: 'Learning', context: 'Context', learned: 'What we learned', future: 'How to apply in future', futureHint: '_Record how this knowledge can be reused._' },
  },
};
function noteLabels(localeId) { return NOTE_LABELS[localeId] || NOTE_LABELS['pt-BR']; }

export function buildBugNoteContent(bug, issueRef, dateStr, sessionRel, provider = providerMeta(), contentKey = derivedContentKey(bug.rootCause), localeId = 'pt-BR') {
  const L = noteLabels(localeId);
  const title = issueRef
    ? `${issueRef} - ${normalizeInline(bug.rootCause, 80)}`
    : normalizeInline(bug.rootCause, 80);

  return `---
type: bug
date: ${dateStr}
status: fixed
provider: ${provider.id}
content_key: "${contentKey}"
${sessionYamlLinks(sessionRel)}
cssclasses:
  - topic-bug
tags:
${yamlTags(bug.tags.map((tag) => (tag === 'codex' ? provider.tag : tag)))}
severity: ${yamlQuote(bug.severity)}
issue: ${yamlQuote(issueRef || '')}
---

# Bug - ${title}

> [!note] ${L.autoTag}
> ${L.autoLine(provider.label)}
> ${L.session}: ${wikilinkFromRel(sessionRel)}

## ${L.bug.symptom}

${bug.symptom || L.verify}

## ${L.bug.rootCause}

${bug.rootCause}

## ${L.bug.fix}

${markdownList(bug.fixes, L.bug.noFix)}

## ${L.bug.files}

${markdownList(bug.changedFiles.map((file) => `\`${file}\``), L.bug.seeSession)}

## ${L.bug.evidence}

${markdownList(bug.evidence, L.bug.addEvidence)}

## ${L.bug.lessons}

${bug.lessons}
`;
}

export function extractDecisionDetails(tx) {
  const allContent = assistantText(tx);
  const lc = allContent.toLowerCase();
  const metaSignals = [
    /\bextract\w*Details\b/,
    /\bcreateLinkedNotes\b/,
    /\bbuildDecisionNoteContent\b/,
    /\bgetNextAdrNumber\b/,
    /\bsession-stop\.mjs\b/,
    /hasDecisionKeyword|hasAlternatives|hasArchCommit/,
  ];
  if (metaSignals.filter((rx) => rx.test(allContent)).length >= 2) return null;

  // Registro DELIBERADO: linha com rótulo `Decisão:`/`ADR:` (opcional negrito/
  // heading). A palavra "decisão"/"decidimos"/"adotar" solta em prosa do
  // assistente NÃO conta — senão fragmentos de conversa viram ADRs no Vault.
  const hasDecisionKeyword = /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s*)?\*{0,2}\s*(?:decis[ãa]o(?:\s+t[ée]cnica|\s+de\s+arquitetura)?|ADR(?:-\d+)?)\s*\*{0,2}\s*:/im.test(allContent);
  const hasAlternatives = /\b(?:alternativ|em\s+vez\s+de|ao\s+inv[eé]s\s+de|consideramos|op[çc][ãa]o\s+[A-C]|descartamos)\b/i.test(allContent);
  const hasArchCommit = (tx.assistantMessages || []).some((message) =>
    /git commit[^\"]*"(?:refactor|chore|feat)\([^\"]*(?:arch|pattern|convention|design|theme|stack)/i.test(message)
  );

  if (!hasDecisionKeyword && !(hasAlternatives && hasArchCommit)) return null;

  const isMetaText = (text) => {
    if (/[\"']{2,}|[(\[]\?[:!]|\\[bdsw]|\|\||\b(?:const|function|import|return|=>)\b/i.test(text)) return true;
    if ((String(text).match(/[\"'][^\"']+[\"']/g) || []).length >= 3) return true;
    return /extract\w+Details|buildDecisionNote|createLinkedNotes|session-stop/i.test(text);
  };

  const matches = [];
  let match;
  const decisionPattern = /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s*)?\*{0,2}\s*(?:decis[ãa]o(?:\s+t[ée]cnica|\s+de\s+arquitetura)?|ADR(?:-\d+)?)\s*\*{0,2}\s*:\s*\*{0,2}\s*(.{10,500}?)(?:\.\s|\n|$)/gim;
  while ((match = decisionPattern.exec(allContent)) !== null) matches.push(normalizeInline(match[1]));

  if (matches.length === 0 && !hasArchCommit) return null;

  const cleanMatches = matches.filter((item) => !isMetaText(item));
  let title = '';
  let detail = '';
  if (cleanMatches.length > 0) {
    const best = cleanMatches.sort((a, b) => b.length - a.length)[0];
    detail = best;
    title = best.slice(0, 80);
  } else if (hasArchCommit) {
    for (const message of tx.assistantMessages || []) {
      const commitMatch = message.match(/git commit[^\"]*"((?:refactor|feat|chore)\([^\"]+)"/i);
      if (commitMatch) {
        title = commitMatch[1];
        detail = commitMatch[1];
        break;
      }
    }
  }

  if (!title || isMetaText(title)) return null;

  const contextMatch = allContent.match(/\*?\*?contexto\*?\*?\s*[:\s]+(.{20,500}?)(?:\n\n|\n\*\*|$)/i);
  const context = contextMatch && !isMetaText(contextMatch[1])
    ? normalizeInline(contextMatch[1])
    : normalizeInline(firstUserPrompt(tx), 300);

  const consequencesMatch = allContent.match(/\*?\*?consequ[êe]ncia\*?\*?s?\s*[:\s]+(.{20,500}?)(?:\n\n|\n##|$)/i);
  const consequences = consequencesMatch && !isMetaText(consequencesMatch[1])
    ? normalizeInline(consequencesMatch[1])
    : '_Avaliar impacto._';

  const alternatives = [];
  const alternativesPattern = /\b(?:alternativ\w*|op[çc][ãa]\s+[A-C]|consideramos|descartamos)\b[:\s]+(.{10,300}?)(?:\.\s|\n|$)/gim;
  while ((match = alternativesPattern.exec(allContent)) !== null) {
    const text = normalizeInline(match[1]);
    if (text.length > 10 && !isMetaText(text)) alternatives.push(text);
  }

  const tags = ['decisao', 'arquitetura', 'codex'];
  const domainTags = [];
  if (/backend|fastapi|python/i.test(lc) && !/\bbackend.specialist\b/i.test(lc)) domainTags.push('backend');
  if (/mobile|react.?native|expo/i.test(lc)) domainTags.push('mobile');
  if (/database|postgres|alembic|migra/i.test(lc)) domainTags.push('database');
  if (/docker|infra|deploy/i.test(lc)) domainTags.push('infra');
  if (/\btema\b|theme|design.?system/i.test(lc)) domainTags.push('design');
  if (/\btest\b|jest|pytest/i.test(lc) && !/test-linked-notes/i.test(lc)) domainTags.push('testes');
  if (domainTags.length >= 5) return null;
  tags.push(...domainTags);

  return {
    title,
    detail,
    context,
    consequences,
    alternatives,
    tags: uniqueTags(tags),
  };
}

export function buildDecisionNoteContent(decision, adrNum, dateStr, sessionRel, provider = providerMeta(), contentKey = derivedContentKey(decision.title), localeId = 'pt-BR') {
  const L = noteLabels(localeId);
  const adrId = `ADR-${String(adrNum).padStart(4, '0')}`;
  return `---
type: decision
date: ${dateStr}
status: accepted
provider: ${provider.id}
content_key: "${contentKey}"
${sessionYamlLinks(sessionRel)}
cssclasses:
  - topic-decision
tags:
${yamlTags(decision.tags.map((tag) => (tag === 'codex' ? provider.tag : tag)))}
superseded_by: ""
---

# ${adrId} - ${decision.title}

> [!note] ${L.autoTag}
> ${L.autoLine(provider.label)}
> ${L.session}: ${wikilinkFromRel(sessionRel)}

## ${L.dec.context}

${decision.context || L.complete}

## ${L.dec.decision}

${decision.detail}

## ${L.dec.consequences}

${decision.consequences}

## ${L.dec.alternatives}

${markdownList(decision.alternatives, L.dec.noAlt)}
`;
}

export function extractLearningDetails(tx, bugDetails) {
  const allContent = assistantText(tx);
  const learnings = [];
  const seen = new Set();
  let match;

  const fixPattern = /\*\*Fix\s+\d+\s*[—–-]\s*(\w+)\*\*[^:]*:\s*(.{20,500}?)(?:\n\n|\n\*\*|$)/gim;
  while ((match = fixPattern.exec(allContent)) !== null) {
    const scope = match[1];
    const detail = normalizeInline(match[2]);
    const key = detail.toLowerCase().slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      learnings.push({
        title: `${scope}: ${detail.slice(0, 60)}`,
        context: bugDetails?.symptom || normalizeInline(firstUserPrompt(tx), 200),
        content: detail,
        tags: ['aprendizado', 'codex', scope.toLowerCase()],
      });
    }
  }

  // Só registro DELIBERADO conta: linha com rótulo `Aprendizado:`/`Lição:`/`TIL:`
  // (opcional negrito/heading). Frases conversacionais soltas ("a solução foi…",
  // "descobrimos que…", "importante:…") NÃO viram nota — senão prosa do
  // assistente vira aprendizado-lixo e ressuscita a cada Stop.
  const lessonPatterns = [
    /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s*)?\*{0,2}\s*(?:li[çc][ãa]o(?:\s+aprendida)?|aprendizado|lesson(?:\s+learned)?|TIL)\s*\*{0,2}\s*:\s*\*{0,2}\s*(.{15,500}?)(?:\n|$)/gim,
  ];
  for (const pattern of lessonPatterns) {
    while ((match = pattern.exec(allContent)) !== null) {
      const detail = normalizeInline(match[1]);
      const key = detail.toLowerCase().slice(0, 60);
      if (detail.length > 15 && !seen.has(key)) {
        seen.add(key);
        learnings.push({
          title: detail.slice(0, 80),
          context: normalizeInline(firstUserPrompt(tx), 200),
          content: detail,
          tags: ['aprendizado', 'codex'],
        });
      }
    }
  }

  if (bugDetails?.rootCause && !bugDetails.rootCause.startsWith('_')) {
    const key = bugDetails.rootCause.toLowerCase().slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      learnings.push({
        title: `Debugging: ${bugDetails.rootCause.slice(0, 60)}`,
        context: bugDetails.symptom || '',
        content: `**Causa raiz identificada:** ${bugDetails.rootCause}\n\n**Lição:** ${bugDetails.lessons}`,
        tags: ['aprendizado', 'codex', 'debugging'],
      });
    }
  }

  // Sem fallback genérico: sessão que só mexeu em arquivos, sem registro
  // deliberado (`Aprendizado:`/`Lição:`), NÃO vira nota — complemento é manual
  // (regra do Vault). Evita aprendizado-lixo + ressurreição a cada Stop.
  return learnings.length ? learnings.slice(0, 5) : null;
}

export function buildLearningNoteContent(learning, dateStr, sessionRel, provider = providerMeta(), contentKey = derivedContentKey(learning.title), localeId = 'pt-BR') {
  const L = noteLabels(localeId);
  return `---
type: learning
date: ${dateStr}
status: active
provider: ${provider.id}
content_key: "${contentKey}"
${sessionYamlLinks(sessionRel)}
cssclasses:
  - topic-learning
tags:
${yamlTags(learning.tags.map((tag) => (tag === 'codex' ? provider.tag : tag)))}
---

# ${L.learn.title} - ${learning.title}

> [!note] ${L.autoTag}
> ${L.autoLine(provider.label)}
> ${L.session}: ${wikilinkFromRel(sessionRel)}

## ${L.learn.context}

${learning.context || L.complete}

## ${L.learn.learned}

${learning.content}

## ${L.learn.future}

${L.learn.futureHint}
`;
}

const derivedFoldersFor = (vaultBase) => { const f = getLocale(vaultBase).folders; return { bugs: f.bugs, decisions: f.decisions, learnings: f.learnings }; };

function listMd(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
}

// Chaves content_key das derivadas já existentes que linkam esta sessão.
// Vault-wide learning content_keys (recursive over the learnings folder). existingKeysForSession
// only looks at the current session + month, so the same lesson re-extracted on a later day/
// session was duplicated. This dedups a learning against everything already learned in the vault.
function collectLearningKeys(vaultBase) {
  const keys = new Set();
  const root = join(vaultBase, getLocale(vaultBase).folders.learnings);
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        try {
          const m = readFileSync(p, 'utf-8').match(/^content_key:\s*"?(.*?)"?\s*$/m);
          if (m && m[1]) keys.add(m[1]);
        } catch { /* nota ilegível */ }
      }
    }
  };
  walk(root);
  return keys;
}

function existingKeysForSession(vaultBase, sessionRel, dateStr) {
  const wikilink = wikilinkFromRel(sessionRel);
  const out = { bugs: [], decisions: [], learnings: [] };
  for (const [type, folder] of Object.entries(derivedFoldersFor(vaultBase))) {
    const dir = join(vaultBase, monthFolderRelFromDateStr(folder, dateStr, vaultBase));
    for (const fileName of listMd(dir)) {
      try {
        const c = readFileSync(join(dir, fileName), 'utf-8');
        if (!c.includes(sessionRel) && !c.includes(wikilink)) continue;
        const m = c.match(/^content_key:\s*"?(.*?)"?\s*$/m);
        if (m && m[1]) out[type].push(m[1]);
      } catch { /* ignora nota ilegível */ }
    }
  }
  return out;
}

function alreadyHasKey(keys, candidate) {
  return !!candidate && keys.some((k) => keysBate(k, candidate));
}

export function createLinkedNotes(vaultBase, dateStr, sessionRel, tx, options = {}) {
  const linked = { decisions: [], bugs: [], learnings: [] };
  const provider = providerMeta(options.provider);
  const loc = getLocale(vaultBase);
  const locF = loc.folders;
  const bugsDir = join(vaultBase, monthFolderRelFromDateStr(locF.bugs, dateStr, vaultBase));
  const decisionsDir = join(vaultBase, monthFolderRelFromDateStr(locF.decisions, dateStr, vaultBase));
  const learningsDir = join(vaultBase, monthFolderRelFromDateStr(locF.learnings, dateStr, vaultBase));
  ensureDir(bugsDir);
  ensureDir(decisionsDir);
  ensureDir(learningsDir);

  const existingKeys = existingKeysForSession(vaultBase, sessionRel, dateStr);

  const issueRefs = options.issueRefs?.length ? options.issueRefs : extractIssueRefs(tx);
  const bugDetails = extractBugDetails(tx);
  if (bugDetails) {
    const issueRef = issueRefs[0] || '';
    const bugKey = derivedContentKey(bugDetails.rootCause);
    if (!alreadyHasKey(existingKeys.bugs, bugKey)) {
      const causeSlug = slugify(bugDetails.rootCause, 'bug', 40);
      const fileName = issueRef ? `${issueRef}-${causeSlug}.md` : `${dateStr}-bug-${causeSlug}.md`;
      const filePath = join(bugsDir, fileName);
      if (!existsSync(filePath)) writeFileSync(filePath, buildBugNoteContent(bugDetails, issueRef, dateStr, sessionRel, provider, bugKey, loc.id), 'utf-8');
      linked.bugs.push(toVaultRelative(vaultBase, filePath));
      existingKeys.bugs.push(bugKey);
    }
  }

  const decisionDetails = extractDecisionDetails(tx);
  if (decisionDetails) {
    const decisionKey = derivedContentKey(decisionDetails.title);
    if (!alreadyHasKey(existingKeys.decisions, decisionKey)) {
      const titleSlug = slugify(decisionDetails.title, 'decisao', 40);
      const existing = adrFileExistsBySlug(decisionsDir, titleSlug);
      const fileName = existing || `ADR-${String(getNextAdrNumber(vaultBase)).padStart(4, '0')}-${titleSlug}.md`;
      const filePath = join(decisionsDir, fileName);
      if (!existsSync(filePath)) {
        const adrNum = Number(fileName.match(/^ADR-(\d+)/i)?.[1]) || getNextAdrNumber(vaultBase);
        writeFileSync(filePath, buildDecisionNoteContent(decisionDetails, adrNum, dateStr, sessionRel, provider, decisionKey, loc.id), 'utf-8');
      }
      linked.decisions.push(toVaultRelative(vaultBase, filePath));
      existingKeys.decisions.push(decisionKey);
    }
  }

  // Agnostic prose decisions (Codex parity): options-in-prose + short answer -> decision note.
  // One integration point covers live Stop, import and backfill, for every provider. Fail-quiet.
  try {
    for (const rel of captureProseDecisions(vaultBase, { tx, dateStr, sessionRel, provider, localeId: loc.id })) {
      linked.decisions.push(rel);
    }
  } catch { /* prose capture é bônus — nunca derruba a captura principal */ }

  const learnings = extractLearningDetails(tx, bugDetails);
  if (learnings) {
    const vaultLearningKeys = collectLearningKeys(vaultBase); // vault-wide dedup
    for (const learning of learnings) {
      const learningKey = derivedContentKey(learning.title);
      if (alreadyHasKey(existingKeys.learnings, learningKey)) continue;
      if (vaultLearningKeys.has(learningKey)) continue; // already learned elsewhere in the vault
      const learningSlug = slugify(learning.title, 'aprendizado', 40);
      const fileName = `${dateStr}-${learningSlug}.md`;
      const filePath = join(learningsDir, fileName);
      if (!existsSync(filePath)) writeFileSync(filePath, buildLearningNoteContent(learning, dateStr, sessionRel, provider, learningKey, loc.id), 'utf-8');
      linked.learnings.push(toVaultRelative(vaultBase, filePath));
      existingKeys.learnings.push(learningKey);
    }
  }

  return linked;
}
