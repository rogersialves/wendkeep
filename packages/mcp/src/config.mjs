export const MCP_SERVER_KEY = 'wendkeep-vault';

export function mcpServerEntry(vaultPath) {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@bitbonsai/mcpvault@latest', vaultPath],
  };
}

export function selectMcpServers(descriptors, skipIds = []) {
  const skipSet = new Set(skipIds);
  const servers = {};
  for (const descriptor of descriptors || []) {
    if (!descriptor || skipSet.has(descriptor.id)) continue;
    if (typeof descriptor.key !== 'string' || !descriptor.key) continue;
    if (!descriptor.entry || typeof descriptor.entry !== 'object') continue;
    servers[descriptor.key] = descriptor.entry;
  }
  return servers;
}

export function mergeMcpConfig(existing, {
  vaultPath,
  withVault = true,
  servers = {},
} = {}) {
  const config = existing && typeof existing === 'object' ? { ...existing } : {};
  config.mcpServers = { ...(config.mcpServers || {}) };
  if (withVault) config.mcpServers[MCP_SERVER_KEY] = mcpServerEntry(vaultPath);
  Object.assign(config.mcpServers, servers);
  return config;
}
