#!/usr/bin/env node
// UserPromptSubmit: bounded, read-only retrieval from the local evidence index.
import { pathToFileURL } from 'node:url';
import { readHookInput, readSessionRegistry, writeHookOutput } from './obsidian-common.mjs';
import {
  EVIDENCE_SEARCH_MAX_CANDIDATES,
  loadEvidenceIndex,
  recallEvidence,
  renderEvidenceContext,
  searchEvidenceCandidates,
} from './evidence-recall.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';
import { resolveHookOperatingProfile } from './operating-profile-runtime.mjs';
import {
  resolveReadOnlyEvidenceActiveContext,
  scopeEvidenceRows,
} from './active-context-handoff-evidence.mjs';
import { isBootstrapPrompt } from '../packages/integrations/src/prompt-content.mjs';

function scopedRows(rows, activeContext, registry) {
  return scopeEvidenceRows(rows, { activeContext, registry });
}

function indexedScopedEvidence(vaultBase, query, topK, activeContext, registry) {
  const initialLimit = Math.min(
    EVIDENCE_SEARCH_MAX_CANDIDATES,
    Math.max(512, Number(topK || 0) * 64),
  );
  const first = searchEvidenceCandidates(vaultBase, query, {
    candidateLimit: initialLimit,
  });
  let scoped = scopedRows(first.rows, activeContext, registry);
  if (scoped.length >= topK || !first.has_more
      || initialLimit >= EVIDENCE_SEARCH_MAX_CANDIDATES) return scoped;
  const expanded = searchEvidenceCandidates(vaultBase, query, {
    candidateLimit: EVIDENCE_SEARCH_MAX_CANDIDATES,
  });
  scoped = scopedRows(expanded.rows, activeContext, registry);
  return scoped;
}

export function buildPromptEvidenceContext(vaultBase, prompt, {
  topK = 3, maxBytes = 3072, rows = null, activeContext = null, registry = null,
} = {}) {
  const query = sanitizeMemoryText(String(prompt || '')).trim();
  if (!query || isBootstrapPrompt(query)) return '';
  const effectiveRegistry = registry || readSessionRegistry(vaultBase);
  let scoped;
  if (rows) {
    scoped = scopedRows(rows, activeContext, effectiveRegistry);
  } else {
    try {
      scoped = indexedScopedEvidence(vaultBase, query, topK, activeContext, effectiveRegistry);
    } catch {
      scoped = scopedRows(loadEvidenceIndex(vaultBase), activeContext, effectiveRegistry);
    }
  }
  if (!scoped.length) return '';
  return sanitizeMemoryText(renderEvidenceContext(
    recallEvidence(scoped, query, { topK }),
    { maxBytes },
  ));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({
      input,
      activeContextResolver: resolveReadOnlyEvidenceActiveContext,
    });
    if (runtime.bindingError) {
      writeHookOutput({});
    } else {
      const context = buildPromptEvidenceContext(
        runtime.vaultBase,
        input.prompt || input.user_prompt || '',
        {
          activeContext: runtime.activeContext,
          registry: readSessionRegistry(runtime.vaultBase),
        },
      );
      writeHookOutput(context ? {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      } : {});
    }
  } catch {
    writeHookOutput({});
  }
}