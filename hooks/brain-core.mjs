// .agent/hooks/brain-core.mjs
// Camada fria do brain: indexa o frontmatter das notas de sessão (0 token LLM).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, stripYamlQuotes, toVaultRelative } from './obsidian-common.mjs';
import { getLocale } from './locale.mjs';

export function brainDir(vaultBase) {
  return join(vaultBase, '.brain');
}

// Frontmatter YAML simples: escalares `k: v` + listas `k:` seguido de `  - item`.
export function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const data = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];
    if (val === '') {
      const list = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        list.push(stripYamlQuotes(lines[++i].replace(/^\s+-\s+/, '').trim()));
      }
      data[key] = list.length ? list : '';
    } else {
      data[key] = stripYamlQuotes(val.trim());
    }
  }
  return data;
}

function walkMd(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(fp));
    else if (e.name.endsWith('.md')) out.push(fp);
  }
  return out;
}

const DERIVED_RE = /\[\[(0[456]-[^\]|]+?)(?:\|[^\]]*)?\]\]/g;
function derivedLinks(content) {
  const dec = new Set(), bug = new Set(), lea = new Set();
  let m;
  while ((m = DERIVED_RE.exec(content))) {
    const t = m[1];
    if (t.startsWith('04-')) dec.add(t);
    else if (t.startsWith('05-')) bug.add(t);
    else if (t.startsWith('06-')) lea.add(t);
  }
  return { decisions: [...dec], bugs: [...bug], learnings: [...lea] };
}

// Varre 02-Sessões/** e regrava .brain/index.jsonl inteiro. Provider-agnóstico.
export function buildBrainIndex(vaultBase) {
  const rows = [];
  for (const fp of walkMd(join(vaultBase, getLocale(vaultBase).folders.sessions))) {
    let content;
    try { content = readFileSync(fp, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(content);
    if (fm.type && fm.type !== 'session') continue;
    const der = derivedLinks(content);
    rows.push({
      session_id: fm.session_id || '',
      date: fm.date || '',
      provider: fm.provider || '',
      status: fm.status || '',
      summary: fm.summary || '',
      file: toVaultRelative(vaultBase, fp),
      tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
      decisions: der.decisions,
      bugs: der.bugs,
      learnings: der.learnings,
    });
  }
  rows.sort((a, b) => (a.date + a.file).localeCompare(b.date + b.file));
  ensureDir(brainDir(vaultBase));
  const out = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  writeFileSync(join(brainDir(vaultBase), 'index.jsonl'), out, 'utf8');
  return rows;
}

// Lê o índice gravado (linhas JSONL). Usado pelo recall e pelo digest.
export function loadIndex(vaultBase) {
  try {
    return readFileSync(join(brainDir(vaultBase), 'index.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const DIGEST_CAPS = { decisions: 5, sessions: 4, bugs: 2, learnings: 2 };

function adrNumber(path) {
  const m = path.match(/ADR-(\d+)/);
  return m ? Number(m[1]) : -1;
}

// Destila index.jsonl em .brain/DIGEST.md (camada quente, determinístico, 0 token LLM).
// Cap por construção: 1 header + 13 itens (5/4/2/2) + 1 pointer = máx 15 linhas.
export function buildBrainDigest(vaultBase, rows = null) {
  const data = rows ?? loadIndex(vaultBase);
  const byDateDesc = [...data].sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) || String(b.file || '').localeCompare(String(a.file || '')));

  const seen = new Set();
  const pick = (kind, max) => {
    const out = [];
    for (const r of byDateDesc) {
      for (const p of r[kind] || []) {
        if (out.length >= max) return out;
        if (!seen.has(p)) { seen.add(p); out.push(p); }
      }
    }
    return out;
  };

  const decisions = pick('decisions', DIGEST_CAPS.decisions).sort((a, b) => adrNumber(b) - adrNumber(a));
  const sessions = byDateDesc.slice(0, DIGEST_CAPS.sessions);
  const bugs = pick('bugs', DIGEST_CAPS.bugs);
  const learnings = pick('learnings', DIGEST_CAPS.learnings);

  const lines = ['<!-- AUTO-GERADO por brain-core.mjs (0 token LLM). NÃO editar. Rebuild: node .agent/hooks/brain-reindex.mjs -->'];
  for (const d of decisions) lines.push(`- Decisão: [[${d}]]`);
  for (const s of sessions) lines.push(`- Sessão ${s.date} (${s.provider || '?'}): ${s.summary || s.file} → [[${String(s.file || '').replace(/\.md$/, '')}]]`);
  for (const b of bugs) lines.push(`- Bug: [[${b}]]`);
  for (const l of learnings) lines.push(`- Aprendizado: [[${l}]]`);

  const shown = sessions.length;
  if (data.length > shown) lines.push(`- +${data.length - shown} mais no índice — use /brain-recall <tópico>`);

  ensureDir(brainDir(vaultBase));
  writeFileSync(join(brainDir(vaultBase), 'DIGEST.md'), lines.join('\n') + '\n', 'utf8');
  return lines;
}
