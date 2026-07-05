#!/usr/bin/env node
// understand-inject — SessionStart hook (agent-agnostic, run via `npx wendkeep hook
// understand-inject`). If the Understand-Anything domain graph has been generated
// (`.understand-anything/knowledge-graph.json` at the project root), inject a cheap
// slice of it into the session; otherwise stay silent. Never breaks the session.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';

const DOMAIN_TYPES = new Set(['domain', 'flow', 'step']);

// Build the injection text from the project's domain graph. Returns '' when the
// graph is absent/unreadable/empty so the caller can stay silent (fail-quiet).
// Reads only a bounded slice — the full knowledge-graph.json can be large.
export function buildUnderstandInjection(projectRoot, { maxNodes = 30 } = {}) {
  const graphPath = join(projectRoot, '.understand-anything', 'knowledge-graph.json');
  let graph;
  try {
    graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  } catch {
    return '';
  }
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (!nodes.length) return '';

  const domainNodes = nodes.filter((n) => DOMAIN_TYPES.has(n?.type));
  const source = domainNodes.length ? domainNodes : nodes;
  const picked = source.slice(0, maxNodes);

  const lines = picked.map((n) => {
    const title = n?.name || n?.title || n?.id || '(sem nome)';
    const kind = n?.type ? `[${n.type}] ` : '';
    const summary = String(n?.summary || n?.description || '')
      .split('\n')[0]
      .slice(0, 200);
    return `- ${kind}${title}${summary ? ` — ${summary}` : ''}`;
  });

  const remaining = source.length - picked.length;
  const more = remaining > 0
    ? `*…+${remaining} nós. Grafo completo: .understand-anything/knowledge-graph.json*`
    : '';

  return [
    '<understand_domain_graph>',
    'Domain-graph do projeto (Understand-Anything) — mapa de domínios/fluxos:',
    ...lines,
    more,
    '</understand_domain_graph>',
  ]
    .filter(Boolean)
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    readHookInput(); // drain stdin (agent JSON); project root comes from cwd
    const context = buildUnderstandInjection(process.cwd());
    if (!context) {
      writeHookOutput({});
    } else {
      writeHookOutput({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      });
    }
  } catch (error) {
    process.stderr.write(`[understand-inject] falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
