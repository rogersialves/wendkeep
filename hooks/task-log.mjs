#!/usr/bin/env node
// TaskCompleted hook: log plan/task progress into the active session note, so the session records
// what the plan actually advanced through. It writes a durable "## Progresso do plano" section
// placed BEFORE ## Encerramento (survives the reopen/strip cycle) and does NOT try to map to a
// change's tarefas.md N.N (id-spaces differ, fuzzy) — it's a progress trail, not a task tracker.
// The TaskCompleted payload shape isn't fully pinned, so the task text is pulled defensively from
// any plausible field. Fail-open.
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readHookInput, writeHookOutput, getVaultBase, formatHourMinute, providerMeta } from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';
import { resolveSessionEntry } from './session-identity.mjs';
import { mutateSessionNote } from './session-note-io.mjs';

// Pull the task's human text from whatever field the payload carries.
export function taskText(input) {
  const t = input.task || input.tool_input || input.payload || input;
  const cand = t?.content || t?.text || t?.description || t?.title || t?.subject || t?.name
    || t?.prompt || input.content || input.text || input.description || '';
  return String(cand || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Append `line` at the END of a "## <heading>" section placed before ## Encerramento, so entries
// read chronologically. Deduped. Pure.
export function appendProgress(content, line, heading) {
  if (content.includes(line)) return content; // dedup
  const marker = `\n## ${heading}\n`;
  const at = content.indexOf(marker);
  if (at !== -1) {
    const sectionStart = at + marker.length;
    let end = content.indexOf('\n## ', sectionStart);
    if (end === -1) end = content.length;
    const head = content.slice(0, end).replace(/\s+$/, '');
    return `${head}\n${line}\n${content.slice(end)}`;
  }
  const block = `## ${heading}\n\n${line}\n\n`;
  const enc = content.indexOf('\n## Encerramento');
  if (enc === -1) return `${content.trimEnd()}\n\n${block}`;
  return `${content.slice(0, enc).trimEnd()}\n\n${block}${content.slice(enc + 1)}`;
}

export function logTask(vaultBase, input) {
  const text = taskText(input);
  if (!text) return false;
  const { identity, entry } = resolveSessionEntry(vaultBase, input, providerMeta(input.provider).id);
  if (identity.state !== 'resolved') return false;
  const sessionRel = entry?.session_file || '';
  if (!sessionRel) return false;
  const sessionPath = join(vaultBase, sessionRel);
  if (!existsSync(sessionPath)) return false;

  const heading = getLocale(vaultBase).id === 'en' ? 'Plan progress' : 'Progresso do plano';
  const line = `- [x] ${formatHourMinute(new Date()).replace('-', ':')} ${text}`;
  return mutateSessionNote(sessionPath, (content) => appendProgress(content, line, heading)).written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    logTask(getVaultBase(input), input);
    writeHookOutput({});
  } catch (error) {
    process.stderr.write(`[wendkeep] task-log falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
