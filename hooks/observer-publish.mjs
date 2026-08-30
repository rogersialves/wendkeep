#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { debugLog, readHookInput, resolveVault } from './obsidian-common.mjs';
import { publishObserverSnapshot, resolveObserverPublisherSecurity } from '../src/observer-publish.mjs';

async function main() {
  const input = readHookInput();
  const resolved = resolveVault(input);
  const publisherSecurity = resolveObserverPublisherSecurity();
  const result = await publishObserverSnapshot({
    vaultBase: resolved.base,
    projectRoot: resolved.projectRoot,
    input,
    ...publisherSecurity,
  });
  if (!result.ok && result.error) debugLog('Observer publish fail-open:', result.error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    debugLog('Observer hook falhou de forma fail-open:', error);
    process.exitCode = 0;
  });
}
