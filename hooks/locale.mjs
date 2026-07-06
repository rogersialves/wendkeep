// hooks/locale.mjs — vault locale (i18n, 0.8.0). The locale is a property of the VAULT,
// stored at <vault>/.brain/config.json ({ "locale": "en" }); absent = pt-BR (full backward
// compat). Parsers stay bilingual everywhere; only RENDERING follows the locale.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCALES = {
  'pt-BR': {
    id: 'pt-BR',
    folders: {
      inbox: '00-Inbox',
      project: '01-Projeto',
      sessions: '02-Sessões',
      linear: '03-Linear',
      decisions: '04-Decisões',
      bugs: '05-Bugs',
      learnings: '06-Aprendizados',
      specs: '07-Specs',
      changes: '08-Mudanças',
    },
    months: ['01-JAN', '02-FEV', '03-MAR', '04-ABR', '05-MAI', '06-JUN', '07-JUL', '08-AGO', '09-SET', '10-OUT', '11-NOV', '12-DEZ'],
    reqHeading: 'Requisito',
    fixTaskVerb: 'mata mutante',
    coreSections: ['Preferências do Usuário', 'Padrões Ativos', 'Pendências Abertas'],
  },
  en: {
    id: 'en',
    folders: {
      inbox: '00-Inbox',
      project: '01-Project',
      sessions: '02-Sessions',
      linear: '03-Linear',
      decisions: '04-Decisions',
      bugs: '05-Bugs',
      learnings: '06-Learnings',
      specs: '07-Specs',
      changes: '08-Changes',
    },
    months: ['01-JAN', '02-FEB', '03-MAR', '04-APR', '05-MAY', '06-JUN', '07-JUL', '08-AUG', '09-SEP', '10-OCT', '11-NOV', '12-DEC'],
    reqHeading: 'Requirement',
    fixTaskVerb: 'kill mutant',
    coreSections: ['User Preferences', 'Active Patterns', 'Open Items'],
  },
};

export const DEFAULT_LOCALE = 'pt-BR';

// Per-process cache: one vault per process (hooks + CLI), reads are hot paths.
const cache = new Map();

export function getLocale(vaultBase) {
  if (!vaultBase) return LOCALES[DEFAULT_LOCALE];
  const key = String(vaultBase);
  if (cache.has(key)) return cache.get(key);
  let id = DEFAULT_LOCALE;
  try {
    const data = JSON.parse(readFileSync(join(key, '.brain', 'config.json'), 'utf8'));
    if (data.locale && LOCALES[data.locale]) id = data.locale;
  } catch { /* sem config = pt-BR */ }
  const loc = LOCALES[id];
  cache.set(key, loc);
  return loc;
}

// Test hook: drop the memoized entry (tests rewrite config.json under one tmpdir).
export function clearLocaleCache() {
  cache.clear();
}

// The full vault taxonomy for a locale (folders + fixed entries), in creation order.
export function vaultFolders(loc) {
  return [...Object.values(loc.folders), 'Templates', '.brain'];
}
