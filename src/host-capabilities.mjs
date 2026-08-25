import {
  buildCoverageFromManifest,
} from '../packages/integrations/src/capabilities.mjs';
import {
  MCP_EFFECT_MANIFEST,
  verifyMcpEffectManifest,
} from '../packages/mcp/src/effects.mjs';

function summarizeToolEffects(manifest) {
  const validation = verifyMcpEffectManifest(manifest);
  const effects = new Set(validation.valid ? manifest.tools.map((tool) => tool.effect) : []);
  return {
    manifest_valid: validation.valid,
    catalog_version: validation.valid ? manifest.catalog_version : '',
    read: effects.has('read'),
    write: effects.has('write'),
    destructive: effects.has('destructive'),
    unknown: 'fail-closed',
  };
}

export function buildHostCoverage({
  hostId,
  hostVersion = '',
  effectManifest = MCP_EFFECT_MANIFEST,
  observedAt,
} = {}) {
  return buildCoverageFromManifest({
    hostId,
    hostVersion,
    observedAt,
    toolEffects: summarizeToolEffects(effectManifest),
  });
}
