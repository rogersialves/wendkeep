#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  controlPath,
  getVaultBase,
  listMarkdownFiles,
  readControl,
  readSessionRegistry,
  wikilinkFromRel,
} from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

const DEFAULT_PENDING_PATTERNS = [
  /^- \[ \] Revisar resumo da sessão$/i,
  /^- \[ \] Verificar se houve decisões a registrar$/i,
  /^- \[ \] Verificar se houve bugs a registrar$/i,
  /^- \[ \] Verificar se houve aprendizados a registrar$/i,
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function findDuplicateTurnMarkers(content) {
  const seen = new Set();
  const duplicated = new Set();
  const regex = /<!-- (?:wk-turn|codex-turn): ([^>]+) -->/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const turnId = match[1].trim();
    if (seen.has(turnId)) duplicated.add(turnId);
    seen.add(turnId);
  }
  return [...duplicated];
}

function hasHeadingAfterClosing(content) {
  const closing = content.indexOf('\n## Encerramento');
  if (closing === -1) return false;
  return /\n#{2,3} /.test(content.slice(closing + '\n## Encerramento'.length));
}

function sectionBody(content, heading) {
  const marker = `\n## ${heading}\n`;
  const start = content.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = start + marker.length;
  const next = content.slice(bodyStart).search(/\n## /);
  const bodyEnd = next === -1 ? content.length : bodyStart + next;
  return content.slice(bodyStart, bodyEnd);
}

function hasDefaultPending(content) {
  return sectionBody(content, 'Pendências')
    .split('\n')
    .some((line) => DEFAULT_PENDING_PATTERNS.some((pattern) => pattern.test(line.trim())));
}

function usageSectionIsPlaced(content, { active = false } = {}) {
  const usage = content.indexOf('\n## Uso de tokens e custos');
  if (usage === -1) return true;
  const changed = content.indexOf('\n## Arquivos criados ou alterados');
  const pending = content.indexOf('\n## Pendências');
  const closing = content.indexOf('\n## Encerramento');
  if (pending === -1 || (!active && closing === -1)) return false;
  return usage < pending && (active || usage < closing) && (changed === -1 || usage > changed);
}

function linkedNotesFromSession(content) {
  const notes = [];
  const regex = /\[\[((?:04-Decisões|05-Bugs|06-Aprendizados)\/[^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!notes.includes(match[1])) notes.push(match[1]);
  }
  return notes;
}

function checkSession({ vaultBase, sessionRel, control, registry }) {
  const failures = [];
  const warnings = [];
  const metrics = {};
  const sessionPath = join(vaultBase, sessionRel);

  if (!existsSync(sessionPath)) {
    failures.push(`Sessão não encontrada: ${sessionRel}`);
    return { failures, warnings, metrics };
  }

  const content = readFileSync(sessionPath, 'utf-8');
  const activeSession = control.status === 'active' && control.session_file === sessionRel;
  const duplicates = findDuplicateTurnMarkers(content);
  metrics.turnMarkers = (content.match(/<!-- (?:wk-turn|codex-turn):/g) || []).length;
  metrics.duplicateTurnMarkers = duplicates.length;

  if (duplicates.length) failures.push(`Marcadores de turno duplicados: ${duplicates.join(', ')}`);
  if (hasHeadingAfterClosing(content)) failures.push('Há headings/iterações após ## Encerramento.');
  if (!usageSectionIsPlaced(content, { active: activeSession })) failures.push('## Uso de tokens e custos está fora da posição esperada.');
  if (hasDefaultPending(content)) warnings.push('Pendências ainda contém placeholders padrão.');

  const registryEntry = registry.sessions?.[control.session_id];
  if (control.session_id && !registryEntry) {
    failures.push(`SESSION_REGISTRY não possui session_id ativo: ${control.session_id}`);
  } else if (registryEntry) {
    if (registryEntry.session_file !== sessionRel) {
      failures.push('SESSION_REGISTRY diverge do CURRENT_SESSION.md para a sessão ativa.');
    }
    if (!registryEntry.transcript_path) {
      warnings.push('SESSION_REGISTRY não possui transcript_path para a sessão ativa.');
    } else if (!existsSync(registryEntry.transcript_path)) {
      warnings.push(`Transcript da sessão ativa não encontrado: ${registryEntry.transcript_path}`);
    }
  }

  const sessionLink = wikilinkFromRel(sessionRel);
  for (const noteRel of linkedNotesFromSession(content)) {
    const notePath = join(vaultBase, noteRel.endsWith('.md') ? noteRel : `${noteRel}.md`);
    if (!existsSync(notePath)) {
      failures.push(`Nota derivada linkada não existe: ${noteRel}`);
      continue;
    }
    const noteContent = readFileSync(notePath, 'utf-8');
    if (!noteContent.includes(sessionLink) && !noteContent.includes(sessionRel)) {
      failures.push(`Nota derivada sem backlink para a sessão: ${noteRel}`);
    }
  }

  return { failures, warnings, metrics };
}

export function runVaultHealth({ vaultBase, session = '' }) {
  const control = readControl(vaultBase);
  const registry = readSessionRegistry(vaultBase);
  const sessionRel = session || control.session_file || control.last_session_file || '';
  const failures = [];
  const warnings = [];

  if (!existsSync(controlPath(vaultBase))) {
    failures.push('CURRENT_SESSION.md não encontrado.');
  }
  if (!sessionRel) failures.push('Nenhuma sessão ativa ou última sessão encontrada no controle.');

  const sessionResult = sessionRel
    ? checkSession({ vaultBase, sessionRel, control, registry })
    : { failures: [], warnings: [], metrics: {} };
  failures.push(...sessionResult.failures);
  warnings.push(...sessionResult.warnings);

  const staleDone = Object.values(registry.sessions || {})
    .filter((item) => item.status === 'active' && item.ended_at)
    .length;
  if (staleDone) warnings.push(`${staleDone} entradas active com ended_at no SESSION_REGISTRY.`);

  const locF = getLocale(vaultBase).folders;
  const derivedFolders = [locF.decisions, locF.bugs, locF.learnings];
  const derivedCount = derivedFolders.reduce((total, folder) => {
    const dir = join(vaultBase, folder);
    return total + (existsSync(dir) ? listMarkdownFiles(dir).length : 0);
  }, 0);

  return {
    ok: failures.length === 0,
    session: sessionRel,
    failures,
    warnings,
    metrics: {
      ...sessionResult.metrics,
      registrySessions: Object.keys(registry.sessions || {}).length,
      derivedNotes: derivedCount,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultBase = getVaultBase({ obsidian_vault_path: args.vault });
  const result = runVaultHealth({ vaultBase, session: args.session || '' });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[wendkeep] Vault health falhou: ${error.message}\n`);
    process.exitCode = 1;
  }
}
