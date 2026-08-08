import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { getLocale } from '../hooks/locale.mjs';
import {
  decideMemoryCandidate,
  listMemoryCandidatesForCuration,
} from './memory.mjs';

const TEXT = {
  'pt-BR': {
    title: 'Curadoria guiada de memória',
    intro: (count) => `${count} conflito(s) aguardam uma decisão humana. Nada será escolhido automaticamente.`,
    categories: 'Categorias pendentes:',
    progress: (index, total, label) => `Conflito ${index} de ${total} — ${label}`,
    source: 'origem',
    sourceKinds: {
      session: 'sessão capturada', turn: 'turno capturado',
      activation: 'ativação capturada', unknown: 'não identificada',
    },
    observed: 'registrado em',
    newer: 'mais recente',
    actions: '[1-N] Manter uma versão · [P] Pular · [R] Encerrar sem vencedor · [D] Detalhes · [Q] Sair',
    choose: '> ',
    confirmPromote: (number) => `Manter a versão ${number}? Essa decisão será gravada agora. [s/N] `,
    confirmReject: 'Encerrar este conflito sem escolher uma versão? Essa decisão será gravada agora. [s/N] ',
    invalid: 'Opção inválida. Escolha um número exibido, P, R, D ou Q.',
    declined: 'Decisão não confirmada; nenhum byte foi alterado.',
    promoted: 'Versão promovida e decisão auditada.',
    rejected: 'Conflito encerrado sem promover uma versão.',
    details: 'Detalhes técnicos',
    paused: (decisions, skipped) => `Sessão encerrada: ${decisions} decisão(ões) gravada(s), ${skipped} conflito(s) pulado(s).`,
    complete: (decisions) => `Curadoria concluída: ${decisions} decisão(ões) gravada(s); nenhum conflito semântico ativo restante.`,
    blocked: 'O estado da memória mudou ou está ocupado. Nada mais foi aplicado; execute memory curate novamente.',
    noConflicts: 'Nenhum conflito semântico ativo precisa de curadoria.',
  },
  en: {
    title: 'Guided memory curation',
    intro: (count) => `${count} conflict(s) require a human decision. Nothing will be selected automatically.`,
    categories: 'Pending categories:',
    progress: (index, total, label) => `Conflict ${index} of ${total} — ${label}`,
    source: 'source',
    sourceKinds: {
      session: 'captured session', turn: 'captured turn',
      activation: 'captured activation', unknown: 'unidentified',
    },
    observed: 'recorded at',
    newer: 'newest timestamp',
    actions: '[1-N] Keep one version · [P] Skip · [R] Close without a winner · [D] Details · [Q] Quit',
    choose: '> ',
    confirmPromote: (number) => `Keep version ${number}? This decision will be written now. [y/N] `,
    confirmReject: 'Close this conflict without choosing a version? This decision will be written now. [y/N] ',
    invalid: 'Invalid option. Choose a displayed number, P, R, D, or Q.',
    declined: 'Decision not confirmed; no bytes were changed.',
    promoted: 'Version promoted and decision audited.',
    rejected: 'Conflict closed without promoting a version.',
    details: 'Technical details',
    paused: (decisions, skipped) => `Session ended: ${decisions} decision(s) written, ${skipped} conflict(s) skipped.`,
    complete: (decisions) => `Curation complete: ${decisions} decision(s) written; no active semantic conflicts remain.`,
    blocked: 'Memory state changed or is busy. Nothing else was applied; run memory curate again.',
    noConflicts: 'No active semantic conflict requires curation.',
  },
};

const KEY_TEXT = {
  'handoff.latest': {
    'pt-BR': ['Próximo handoff', 'Resumo que será apresentado à próxima sessão.'],
    en: ['Next handoff', 'Summary that will be presented to the next session.'],
  },
  'quality.latest-sensors': {
    'pt-BR': ['Sensores de qualidade', 'Conjunto de testes e sensores considerado mais recente.'],
    en: ['Quality sensors', 'Test and sensor set considered the latest.'],
  },
  'quality.latest-verdict': {
    'pt-BR': ['Veredito de qualidade', 'Resultado de verificação apresentado como vigente.'],
    en: ['Quality verdict', 'Verification result presented as current.'],
  },
  'git.local-head': {
    'pt-BR': ['Commit local conhecido', 'Commit que o WendKeep considera o último estado local.'],
    en: ['Known local commit', 'Commit WendKeep considers the latest local state.'],
  },
};

function localeId(value) {
  return value === 'en' ? 'en' : 'pt-BR';
}

function keyText(memoryKey, locale) {
  return KEY_TEXT[memoryKey]?.[locale]
    || (locale === 'en'
      ? [memoryKey, 'Operational memory value with competing versions.']
      : [memoryKey, 'Valor operacional com versões concorrentes.']);
}

function isAffirmative(answer) {
  return ['s', 'sim', 'y', 'yes'].includes(String(answer || '').trim().toLowerCase());
}

function groupLines(candidates, locale) {
  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.memory_key, (counts.get(candidate.memory_key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `  • ${keyText(key, locale)[0]}: ${count}`);
}

function newestEventId(events) {
  return [...events]
    .filter((event) => !Number.isNaN(Date.parse(event.observed_at || '')))
    .sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0]?.event_id;
}

export function renderMemoryConflict(candidate, {
  locale = 'pt-BR', index = 1, total = 1, details = false,
} = {}) {
  const id = localeId(locale);
  const text = TEXT[id];
  const [label, description] = keyText(candidate.memory_key, id);
  const newest = newestEventId(candidate.events);
  const lines = ['', text.progress(index, total, label), description, ''];
  candidate.events.forEach((event, eventIndex) => {
    const recent = event.event_id === newest ? ` — ${text.newer}` : '';
    const source = text.sourceKinds[event.source] || text.sourceKinds.unknown;
    lines.push(`[${eventIndex + 1}] ${text.source}: ${source}${recent}`);
    if (event.observed_at) lines.push(`    ${text.observed}: ${event.observed_at}`);
    lines.push(`    ${event.preview}`);
  });
  if (details) {
    lines.push('', `${text.details}:`, `  candidate: ${candidate.candidate_id}`);
    candidate.events.forEach((event) => lines.push(`  event: ${event.event_id}`));
  }
  lines.push('', text.actions);
  return `${lines.join('\n')}\n`;
}

export async function runGuidedMemoryCuration(vault, {
  ask,
  write,
  loadCandidates = listMemoryCandidatesForCuration,
  decide = decideMemoryCandidate,
  locale = 'pt-BR',
} = {}) {
  if (typeof ask !== 'function' || typeof write !== 'function') {
    throw new TypeError('runGuidedMemoryCuration requer ask e write.');
  }
  const id = localeId(locale);
  const text = TEXT[id];
  let decisions = 0;
  let skipped = 0;
  const skippedIds = new Set();
  const decidedIds = new Set();
  let first = true;
  let sessionTotal = 0;

  while (true) {
    let loaded;
    try {
      loaded = loadCandidates(vault);
      if (!Array.isArray(loaded)) throw new TypeError('candidate inventory must be an array');
    } catch {
      write(`${text.blocked}\n`);
      return { status: 'blocked', decisions, skipped };
    }
    const candidates = loaded.filter((candidate) => !skippedIds.has(candidate.candidate_id));
    if (first) {
      sessionTotal = loaded.length;
      write(`${text.title}\n${text.intro(loaded.length)}\n`);
      if (loaded.length) write(`${text.categories}\n${groupLines(loaded, id).join('\n')}\n`);
      first = false;
    }
    if (!loaded.length) {
      write(`${decisions ? text.complete(decisions) : text.noConflicts}\n`);
      return { status: 'complete', decisions, skipped };
    }
    if (!candidates.length) {
      write(`${text.paused(decisions, skipped)}\n`);
      return { status: 'paused', decisions, skipped };
    }

    const candidate = candidates[0];
    if (decidedIds.has(candidate.candidate_id)) {
      write(`${text.blocked}\n`);
      return { status: 'blocked', decisions, skipped };
    }
    const completed = decisions + skipped;
    const progressTotal = Math.max(sessionTotal, completed + candidates.length);
    const progressIndex = completed + 1;
    write(renderMemoryConflict(candidate, {
      locale: id, index: progressIndex, total: progressTotal,
    }));
    const answer = String(await ask(text.choose)).trim().toLowerCase();

    if (answer === 'q') {
      write(`${text.paused(decisions, skipped)}\n`);
      return { status: 'quit', decisions, skipped };
    }
    if (answer === 'p') {
      skippedIds.add(candidate.candidate_id);
      skipped += 1;
      continue;
    }
    if (answer === 'd') {
      write(renderMemoryConflict(candidate, {
        locale: id, index: progressIndex, total: progressTotal, details: true,
      }));
      continue;
    }

    let decision;
    let confirmation;
    if (answer === 'r') {
      decision = { action: 'reject', candidateId: candidate.candidate_id };
      confirmation = await ask(text.confirmReject);
    } else if (/^\d+$/.test(answer)) {
      const eventIndex = Number(answer) - 1;
      const selected = candidate.events[eventIndex];
      if (!selected) {
        write(`${text.invalid}\n`);
        continue;
      }
      decision = {
        action: 'promote', candidateId: candidate.candidate_id, eventId: selected.event_id,
      };
      confirmation = await ask(text.confirmPromote(eventIndex + 1));
    } else {
      write(`${text.invalid}\n`);
      continue;
    }

    if (!isAffirmative(confirmation)) {
      write(`${text.declined}\n`);
      continue;
    }

    let result;
    try {
      result = decide(vault, decision);
    } catch {
      write(`${text.blocked}\n`);
      return { status: 'blocked', decisions, skipped };
    }
    if (!result || !['promoted', 'rejected'].includes(result.status)) {
      write(`${text.blocked}\n`);
      return { status: 'blocked', decisions, skipped };
    }
    decisions += 1;
    decidedIds.add(candidate.candidate_id);
    write(`${result.status === 'promoted' ? text.promoted : text.rejected}\n`);
  }
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'WENDKEEP_MEMORY_CURATE_USAGE';
  return error;
}

export function parseMemoryCurateArgs(argv) {
  let vault = '';
  let seenVault = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw usageError(`argumento posicional inesperado: ${token}.`);
    const equalAt = token.indexOf('=');
    const name = equalAt >= 0 ? token.slice(0, equalAt) : token;
    if (name !== '--vault') throw usageError(`opção desconhecida: ${name}.`);
    if (seenVault) throw usageError('--vault duplicado.');
    const value = equalAt >= 0 ? token.slice(equalAt + 1) : argv[index + 1];
    if (!value || !value.trim() || value.startsWith('--')) {
      throw usageError('--vault requer valor não vazio que não comece com --.');
    }
    vault = value;
    seenVault = true;
    if (equalAt < 0) index += 1;
  }
  return { vault };
}

export async function runMemoryCurateCli(argv, {
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  env = process.env,
} = {}) {
  let args;
  try {
    args = parseMemoryCurateArgs(argv);
  } catch {
    error.write(
      'wendkeep memory curate: não foi possível abrir a curadoria com segurança. '
      + 'Inspecione o estado com memory candidates --active e tente novamente.\n',
    );
    return 2;
  }
  const vault = args.vault || env.OBSIDIAN_VAULT_PATH;
  if (!vault) {
    error.write('wendkeep memory curate: passe --vault <path>.\n');
    return 2;
  }
  if (!existsSync(vault)) {
    error.write(`wendkeep memory curate: not found: ${vault}\n`);
    return 2;
  }
  if (!input?.isTTY || !output?.isTTY) {
    error.write(
      `wendkeep memory curate requer terminal interativo (TTY). Inspecione sem alterar com: `
      + `npx --no-install wendkeep memory candidates --active --vault "${vault}"\n`,
    );
    return 2;
  }

  const rl = createInterface({ input, output });
  try {
    const result = await runGuidedMemoryCuration(vault, {
      locale: getLocale(vault).id,
      ask: (question) => rl.question(question),
      write: (value) => output.write(String(value)),
    });
    return result.status === 'blocked' ? 1 : 0;
  } catch (cause) {
    error.write(`wendkeep memory curate: ${cause.message}\n`);
    return 1;
  } finally {
    rl.close();
  }
}
