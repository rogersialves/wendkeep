import { hasTurnMarker, normalizeTurnMarkers, turnMarker } from './obsidian-common.mjs';
import { hasSessionFrontmatter, mutateSessionNote } from './session-note-io.mjs';

const ITERATION_ANCHORS = [
  '\n## Agentes, tokens e custos',
  '\n## Uso de tokens e custos',
  '\n## Decisões geradas nesta sessão',
  '\n## Bugs gerados nesta sessão',
  '\n## Aprendizados gerados nesta sessão',
  '\n## Arquivos consultados',
  '\n## Arquivos criados ou alterados',
  '\n## Pendências',
  '\n## Encerramento',
];

export function insertIterationContent(original, { markerId, block }) {
  if (!markerId) throw new TypeError('markerId é obrigatório');
  let content = normalizeTurnMarkers(String(original || ''));
  if (hasTurnMarker(content, markerId)) return { content, inserted: false };

  const rendered = `\n${String(block || '').trim()}\n${turnMarker(markerId)}\n`;
  const iterations = content.indexOf('\n## Iterações');
  if (iterations !== -1) {
    const anchors = ITERATION_ANCHORS
      .map((anchor) => content.indexOf(anchor, iterations + 1))
      .filter((index) => index !== -1)
      .sort((left, right) => left - right);
    if (anchors.length) {
      const at = anchors[0];
      content = `${content.slice(0, at).trimEnd()}\n${rendered}\n${content.slice(at).replace(/^\n+/, '')}`;
    } else {
      const lineEnd = content.indexOf('\n', iterations + 1);
      const at = lineEnd === -1 ? content.length : lineEnd + 1;
      content = `${content.slice(0, at).trimEnd()}\n${rendered}\n${content.slice(at).replace(/^\n+/, '')}`;
    }
    return { content, inserted: true };
  }

  const closing = content.indexOf('\n## Encerramento');
  if (closing !== -1) {
    content = `${content.slice(0, closing).trimEnd()}\n\n## Iterações\n${rendered}\n${content.slice(closing).replace(/^\n+/, '')}`;
  } else {
    content = `${content.trimEnd()}\n\n## Iterações\n${rendered}`;
  }
  return { content, inserted: true };
}

export function projectSessionIteration(sessionPath, input, options = {}) {
  let inserted = false;
  let invalidFrontmatter = false;
  const outcome = mutateSessionNote(sessionPath, (content) => {
    if (!hasSessionFrontmatter(content)) {
      invalidFrontmatter = true;
      return null;
    }
    const result = insertIterationContent(content, input);
    inserted = result.inserted;
    return result.content;
  }, options);
  return {
    inserted,
    written: outcome.written,
    reason: invalidFrontmatter ? 'invalid-frontmatter' : outcome.reason,
  };
}
