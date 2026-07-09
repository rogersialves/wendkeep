#!/usr/bin/env node
// PostToolUse hook (matcher: AskUserQuestion). When the agent asks the user to choose between
// options, this records the decision — the question, EVERY option (label + description), and the
// user's choice — as a note in 04-Decisões, wikilinked to the session. Explicit, high-signal
// decisions get full traceability in the graph (better than heuristic extraction). Fail-open.
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  readHookInput, writeHookOutput, getVaultBase, providerMeta, ensureDir, formatDate,
  formatLocalIso, monthFolderRelFromDateStr, slugify, findActiveSessionByTranscript,
  wikilinkFromRel, readControl, toVaultRelative,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

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
export function buildDecisionCaptureNote({ questions, answers, dateStr, startedAt, sessionRel, provider, localeId }) {
  const en = localeId === 'en';
  const src = sessionRel ? `\n  - "${wikilinkFromRel(sessionRel)}"` : ' []';
  const title = clean(questions[0]?.question || (en ? 'User decision' : 'Decisão do usuário')).slice(0, 90);

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
cssclasses:
  - topic-decision
tags:
  - decisao
  - escolha-usuario
source:${src}
---

# ${title}

> ${en ? 'Decision captured from an interactive question (options + the user\'s choice).' : 'Decisão capturada de uma pergunta interativa (opções + a escolha do usuário).'}

${blocks}
`;
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
  const slug = slugify(questions[0]?.question || 'decisao', 'decisao', 50);
  const filePath = join(dir, `${dateStr}-escolha-${slug}.md`);
  if (existsSync(filePath)) return { rel: toVaultRelative(vaultBase, filePath), skipped: true };

  writeFileSync(filePath, buildDecisionCaptureNote({
    questions, answers, dateStr, startedAt: formatLocalIso(now), sessionRel, provider, localeId: loc.id,
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
