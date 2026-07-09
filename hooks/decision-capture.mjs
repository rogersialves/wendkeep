#!/usr/bin/env node
// PostToolUse hook (matcher: AskUserQuestion). When the agent asks the user to choose between
// options, this records the decision — the question, EVERY option (label + description), and the
// user's choice — as a note in 04-Decisões, wikilinked to the session. Explicit, high-signal
// decisions get full traceability in the graph (better than heuristic extraction). Fail-open.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  readHookInput, writeHookOutput, getVaultBase, providerMeta, ensureDir, formatDate,
  formatLocalIso, monthFolderRelFromDateStr, slugify, findActiveSessionByTranscript,
  wikilinkFromRel, readControl, toVaultRelative, getNextAdrNumber, derivedContentKey,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

// Decision notes follow the ADR naming convention: ADR-NNNN-<slug>, NNNN a 4-digit sequential
// number assigned in the order decisions are made (getNextAdrNumber scans the whole 04-Decisões).
export const padAdr = (n) => String(n).padStart(4, '0');

// Dedup is content-based now (the filename carries a fresh ADR number, so it can't dedup): a
// decision already recorded (same content_key) in the target folder is not written again.
export function decisionKeyExists(dir, key) {
  if (!key) return false;
  let names;
  try { names = readdirSync(dir); } catch { return false; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    try {
      const m = readFileSync(join(dir, n), 'utf8').match(/^content_key:\s*"?(.*?)"?\s*$/m);
      if (m && m[1] === key) return true;
    } catch { /* nota ilegível */ }
  }
  return false;
}

// The AskUserQuestion tool_output reads: `... "Question"="chosen labels"  "Q2"="..."`.
export function parseAnswers(output) {
  const map = {};
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(output || '')))) map[m[1].trim()] = m[2].trim();
  return map;
}

const clean = (s) => String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

// Render the decision note from an AskUserQuestion tool call.
export function buildDecisionCaptureNote({ questions, answers, dateStr, startedAt, sessionRel, provider, localeId, adrNum = 0, contentKey = '' }) {
  const en = localeId === 'en';
  const src = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  const title = clean(questions[0]?.question || (en ? 'User decision' : 'Decisão do usuário')).slice(0, 90);
  const adrLabel = adrNum ? `ADR-${padAdr(adrNum)} — ` : '';

  const blocks = questions.map((q) => {
    const chosen = (answers[clean(q.question)] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isChosen = (label) => chosen.some((c) => c === label.trim() || c.includes(label.trim()) || label.trim().includes(c));
    const opts = (q.options || [])
      .map((o) => `| ${isChosen(o.label) ? '✅' : ''} | ${clean(o.label)} | ${clean(o.description).slice(0, 200)} |`)
      .join('\n');
    return `### ${clean(q.question)}
${q.multiSelect ? (en ? '_(multiple choice)_' : '_(múltipla escolha)_') : ''}

| | ${en ? 'Option' : 'Opção'} | ${en ? 'Description' : 'Descrição'} |
|---|---|---|
${opts || `| | — | — |`}

**${en ? 'Chosen' : 'Escolhido'}:** ${chosen.length ? chosen.map((c) => `\`${c}\``).join(', ') : (en ? '(not recorded)' : '(não registrado)')}`;
  }).join('\n\n');

  return `---
type: decision
subtype: user-choice
date: ${dateStr}
started_at: ${startedAt}
provider: ${provider.id}
${adrNum ? `adr: ${adrNum}\n` : ''}content_key: "${contentKey}"
cssclasses:
  - topic-decision
tags:
  - decisao
  - escolha-usuario
source:${src}
---

# ${adrLabel}${title}

> ${en ? 'Decision captured from an interactive question (options + the user\'s choice).' : 'Decisão capturada de uma pergunta interativa (opções + a escolha do usuário).'}

${blocks}
`;
}

// --- agnostic prose decisions (Codex parity) ---------------------------------
// Codex has no AskUserQuestion-style tool: the agent asks in PROSE and the user answers in the
// next message. Conservative extraction (validated on real rollouts): an assistant message with
// >=2 enumerated options that ends in a question, followed by a SHORT user reply (a choice, not a
// new instruction). Works over the turn conversations both parsers already build — so it covers
// Claude and Codex, live and import, without depending on any hook event.
export function extractProseDecisions(tx) {
  const flat = [];
  for (const t of tx?.turns || []) for (const c of t.conversation || []) flat.push(c);
  const out = [];
  for (let i = 0; i < flat.length - 1; i++) {
    const q = flat[i]; const a = flat[i + 1];
    if (q.role !== 'Assistente' || a.role !== 'Usuário') continue;
    const text = String(q.text || '');
    const answer = String(a.text || '').trim();
    if (!answer || answer.length > 200) continue; // long reply = new instruction, not a choice
    // question: the message's last non-empty lines must end with '?'
    const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    if (!/\?\s*$/.test(lastLine)) continue;
    // options: numbered/lettered lines, or bulleted bold labels
    let options = [...text.matchAll(/^\s*(?:\d+[\).]|[a-cA-C][\)])\s+(.{3,140})$/gm)].map((m) => m[1].trim());
    if (options.length < 2) options = [...text.matchAll(/^\s*[-*]\s+\*\*(.{2,90}?)\*\*/gm)].map((m) => m[1].trim());
    if (options.length < 2) continue;
    const question = lines.filter((l) => /\?\s*$/.test(l)).pop() || lastLine;
    out.push({ question: question.slice(0, 200), options: options.slice(0, 6), answer });
  }
  return out;
}

// Write one decision note per extracted prose decision (same shape as the hook capture).
// Deduped by content_key (question). Returns the vault-relative paths written.
export function captureProseDecisions(vaultBase, { tx, dateStr, sessionRel, provider, localeId }) {
  const written = [];
  const decisions = extractProseDecisions(tx);
  if (!decisions.length) return written;
  const loc = getLocale(vaultBase);
  const dir = join(vaultBase, monthFolderRelFromDateStr(loc.folders.decisions, dateStr, vaultBase));
  for (const d of decisions) {
    const contentKey = derivedContentKey(d.question);
    ensureDir(dir);
    if (decisionKeyExists(dir, contentKey)) continue;
    const adrNum = getNextAdrNumber(vaultBase);
    const filePath = join(dir, `ADR-${padAdr(adrNum)}-${slugify(d.question, 'decisao', 50)}.md`);
    if (existsSync(filePath)) continue;
    writeFileSync(filePath, buildDecisionCaptureNote({
      questions: [{ question: d.question, multiSelect: false, options: d.options.map((label) => ({ label, description: '' })) }],
      answers: { [d.question]: d.answer },
      dateStr, startedAt: `${dateStr}T00:00:00`, sessionRel,
      provider: provider || providerMeta(tx?.provider), localeId: localeId || loc.id, adrNum, contentKey,
    }), 'utf-8');
    written.push(toVaultRelative(vaultBase, filePath));
  }
  return written;
}

export function captureDecision(vaultBase, input) {
  const toolIn = input.tool_input || input.toolInput || {};
  const questions = Array.isArray(toolIn.questions) ? toolIn.questions : [];
  if (!questions.length) return null;

  const answers = parseAnswers(input.tool_output ?? input.toolOutput ?? input.tool_response ?? '');
  const loc = getLocale(vaultBase);
  const now = new Date();
  const dateStr = formatDate(now);
  const provider = providerMeta(input.provider);

  const matched = input.transcript_path ? findActiveSessionByTranscript(vaultBase, input.transcript_path) : null;
  const sessionRel = matched?.session_file || readControl(vaultBase).session_file || '';

  const dir = join(vaultBase, monthFolderRelFromDateStr(loc.folders.decisions, dateStr, vaultBase));
  ensureDir(dir);
  const contentKey = derivedContentKey(questions[0]?.question || 'decisao');
  if (decisionKeyExists(dir, contentKey)) return { rel: '', skipped: true };
  const adrNum = getNextAdrNumber(vaultBase);
  const slug = slugify(questions[0]?.question || 'decisao', 'decisao', 50);
  const filePath = join(dir, `ADR-${padAdr(adrNum)}-${slug}.md`);
  if (existsSync(filePath)) return { rel: toVaultRelative(vaultBase, filePath), skipped: true };

  writeFileSync(filePath, buildDecisionCaptureNote({
    questions, answers, dateStr, startedAt: formatLocalIso(now), sessionRel, provider, localeId: loc.id, adrNum, contentKey,
  }), 'utf-8');
  return { rel: toVaultRelative(vaultBase, filePath), skipped: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    if ((input.tool_name || input.toolName) === 'AskUserQuestion') {
      captureDecision(getVaultBase(input), input);
    }
    writeHookOutput({});
  } catch (error) {
    process.stderr.write(`[wendkeep] decision-capture falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
