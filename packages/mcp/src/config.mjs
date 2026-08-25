export const MCP_SERVER_KEY = 'wendkeep-vault';

export function mcpServerEntry(vaultPath) {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['--no-install', 'wendkeep', 'mcp', 'serve', '--vault', vaultPath],
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function renderMcpClientConfig(client, vaultPath) {
  const selected = String(client || 'generic').toLowerCase();
  const entry = mcpServerEntry(vaultPath);
  if (selected === 'codex') {
    return [
      `[mcp_servers.${MCP_SERVER_KEY}]`,
      `command = ${tomlString(entry.command)}`,
      `args = [${entry.args.map(tomlString).join(', ')}]`,
      '',
    ].join('\n');
  }
  if (!['generic', 'claude', 'cursor'].includes(selected)) {
    throw Object.assign(new Error(`unsupported MCP client: ${client}`), { code: 'MCP_CLIENT_INVALID' });
  }
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2)}\n`;
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
