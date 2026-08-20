#!/usr/bin/env node
// UserPromptSubmit: bounded, read-only retrieval from the local evidence index.
import { pathToFileURL } from 'node:url';
import { readHookInput, writeHookOutput } from './obsidian-common.mjs';
import { loadEvidenceIndex, recallEvidence, renderEvidenceContext } from './evidence-recall.mjs';
import { sanitizeMemoryText } from './memory-schema.mjs';
import { resolveHookOperatingProfile } from './operating-profile-runtime.mjs';
import { isBootstrapPrompt } from '../packages/integrations/src/prompt-content.mjs';

export function buildPromptEvidenceContext(vaultBase, prompt, {
  topK = 3, maxBytes = 3072, rows = null,
} = {}) {
  const query = sanitizeMemoryText(String(prompt || '')).trim();
  if (!query || isBootstrapPrompt(query)) return '';
  const evidence = rows || loadEvidenceIndex(vaultBase);
  if (!evidence.length) return '';
  return sanitizeMemoryText(renderEvidenceContext(
    recallEvidence(evidence, query, { topK }),
    { maxBytes },
  ));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    const runtime = resolveHookOperatingProfile({ input });
    if (runtime.bindingError) {
      writeHookOutput({});
    } else {
      const context = buildPromptEvidenceContext(
        runtime.vaultBase,
        input.prompt || input.user_prompt || '',
      );
      writeHookOutput(context ? {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      } : {});
    }
  } catch {
    writeHookOutput({});
  }
}
