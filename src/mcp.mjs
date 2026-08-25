// Compatibility facade keeps the CLI and hooks from depending directly on a sibling adapter.
export { MCP_HELP, runMcp } from '../packages/mcp/src/cli.mjs';
export {
  MCP_EFFECT_MANIFEST,
  resolveMcpToolEffect,
  verifyMcpEffectManifest,
} from '../packages/mcp/src/effects.mjs';
