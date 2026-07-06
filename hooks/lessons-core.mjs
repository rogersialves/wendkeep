// hooks/lessons-core.mjs — project-local lessons from verification failures (Wave B).
// A failure distilled into a terse lesson; brain-inject surfaces the recent ones at
// SessionStart so the framework gets sharper on your codebase. No external deps.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LESSONS = 50; // dir cap (#7): oldest (filename asc = date asc) pruned first

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'licao';
}

export function addLesson(vaultBase, { trigger, lesson, sourceChange = '', dateStr = '' }) {
  const dir = join(vaultBase, '.brain', 'lessons');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${dateStr ? `${dateStr}-` : ''}${slugify(trigger)}.md`);
  writeFileSync(
    path,
    `---\ntype: lesson\ntrigger: ${JSON.stringify(String(trigger))}\nsource: ${sourceChange}\ndate: ${dateStr}\n---\n\n${lesson}\n`,
    'utf8',
  );
  // Cap the directory (#7): prune oldest-by-name (date-prefixed = chronological).
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_LESSONS))) {
      unlinkSync(join(dir, f));
    }
  } catch { /* prune é bônus */ }
  return path;
}

// Compact <lessons> block of the most recent lessons (filename-sorted desc; a date prefix
// makes that chronological). Budget-capped by `max`. '' when there are none.
export function buildLessonsInjection(vaultBase, { max = 5 } = {}) {
  const dir = join(vaultBase, '.brain', 'lessons');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, max); }
  catch { return ''; }
  const lines = [];
  for (const f of files) {
    try {
      const body = readFileSync(join(dir, f), 'utf8').replace(/^---[\s\S]*?---\n/, '').trim().split('\n')[0];
      if (body) lines.push(`- ${body}`);
    } catch { /* skip */ }
  }
  return lines.length ? `<lessons>\nLições do projeto (de falhas anteriores):\n${lines.join('\n')}\n</lessons>` : '';
}
