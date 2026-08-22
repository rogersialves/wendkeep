#!/usr/bin/env node
// UserPromptSubmit: bounded, read-only retrieval from the local evidence index.
import { pathToFileURL } from 'node:url';
import { readHookInput, readSessionRegistry, writeHookOutput } from './obsidian-common.mjs';
import { loadEvidenceIndex, recallEvidence, renderEvidenceContext } from './evidence-recall.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';
import { resolveHookOperatingProfile } from './operating-profile-runtime.mjs';
import {
  resolveReadOnlyEvidenceActiveContext,
  scopeEvidenceRows,
} from './active-context-handoff-evidence.mjs';
import { isBootstrapPrompt } from '../packages/integrations/src/prompt-content.mjs';

export function buildPromptEvidenceContext(vaultBase, prompt, {
  topK = 3, maxBytes = 3072, rows = null, activeContext = null, registry = null,
} = {}) {
  const query = sanitizeMemoryText(String(prompt || '')).trim();
  if (!query || isBootstrapPrompt(query)) return '';
  const evidence = rows || loadEvidenceIndex(vaultBase);
  const scoped = scopeEvidenceRows(evidence, {
    activeContext,
    registry: registry || readSessionRegistry(vaultBase),
  });
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
