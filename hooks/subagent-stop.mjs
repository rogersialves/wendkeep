#!/usr/bin/env node
// SubagentStop hook: refresh this session's subagent/workflow telemetry the MOMENT a subagent
// finishes — not only at the main Stop. It recomposes the complete main + subagent snapshot
// through the same atomic writer used by Stop/import/rebuild. Fail-open.
//
// Model choice for subagents stays the harness's job (agent frontmatter `model:` / the Task/
// workflow `model` param). wendkeep OBSERVES (this telemetry) rather than dictating a routing rule.
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readHookInput, writeHookOutput, getVaultBase, providerMeta } from './obsidian-common.mjs';
import { updateSessionObservability } from './session-observability.mjs';
import { resolveSessionEntry } from './session-identity.mjs';

export function refreshSubagents(vaultBase, input) {
  const { identity, entry } = resolveSessionEntry(vaultBase, input, providerMeta(input.provider).id);
  if (identity.state !== 'resolved') return false;
  const transcriptPath = identity.transcriptPath;
  const sessionRel = entry?.session_file || '';
  if (!sessionRel) return false;
  const sessionPath = join(vaultBase, sessionRel);
  if (!existsSync(sessionPath)) return false;
  updateSessionObservability({ sessionPath, transcriptPath, caller: 'subagent-stop', canonicalConversationId: identity.canonicalConversationId });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = readHookInput();
    refreshSubagents(getVaultBase(input), input);
    writeHookOutput({});
  } catch (error) {
    process.stderr.write(`[wendkeep] subagent-stop falhou: ${error.message}\n`);
    writeHookOutput({});
  }
}
