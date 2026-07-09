#!/usr/bin/env node
// SubagentStop hook: refresh this session's subagent/workflow telemetry the MOMENT a subagent
// finishes — not only at the main Stop. Resilience: a session that never reaches Stop (crash,
// window closed) still gets its subagent cost notes. Reuses the same upsertSubagentUsage the Stop
// hook runs, so the output is identical; it just runs earlier + incrementally. Fail-open.
//
// Model choice for subagents stays the harness's job (agent frontmatter `model:` / the Task/
// workflow `model` param). wendkeep OBSERVES (this telemetry) rather than dictating a routing rule.
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readHookInput, writeHookOutput, getVaultBase, findActiveSessionByTranscript, readControl } from './obsidian-common.mjs';
import { upsertSubagentUsage } from './subagent-usage.mjs';

export function refreshSubagents(vaultBase, input) {
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const matched = transcriptPath ? findActiveSessionByTranscript(vaultBase, transcriptPath) : null;
  const sessionRel = matched?.session_file || readControl(vaultBase).session_file || '';
  if (!sessionRel) return false;
  const sessionPath = join(vaultBase, sessionRel);
  if (!existsSync(sessionPath)) return false;
  upsertSubagentUsage(sessionPath, transcriptPath);
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
