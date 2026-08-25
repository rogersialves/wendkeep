import { isAbsolute, resolve } from 'node:path';

import { resolveProjectVault } from '../../vault/src/project-vault.mjs';
import { createMcpAuditor } from './audit.mjs';
import { renderMcpClientConfig } from './config.mjs';
import { createNativeMcpServer } from './server.mjs';
import { executeNativeMcpTool } from './executor.mjs';
import { runNativeMcpStdio } from './stdio.mjs';

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

export const MCP_HELP = `wendkeep mcp <serve|config> [options]

Run the native WendKeep semantic MCP server over stdio.

Options:
  --vault <path>       Select the bound Vault for compatibility with project MCP config.
  --timeout-ms <n>     Per-tool execution timeout (default: 10000; maximum: 120000).
  --client <name>      Config output: generic, claude, codex, or cursor.
  --help, -h           Show this help.
`;

export async function runMcp(argv = []) {
  const [subcommand] = argv;
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(MCP_HELP);
    return 0;
  }
  if (subcommand === 'config') {
    const vault = optionValue(argv, '--vault');
    if (!vault) {
      process.stderr.write('wendkeep mcp config: --vault is required\n');
      return 2;
    }
    try {
      process.stdout.write(renderMcpClientConfig(optionValue(argv, '--client') || 'generic', vault));
      return 0;
    } catch (error) {
      process.stderr.write(`wendkeep mcp config: ${error.message}\n`);
      return 2;
    }
  }
  if (subcommand !== 'serve') {
    process.stderr.write(`wendkeep mcp: expected "serve"\n${MCP_HELP}`);
    return 2;
  }
  const timeoutValue = optionValue(argv, '--timeout-ms');
  const timeoutMs = timeoutValue ? Number.parseInt(timeoutValue, 10) : undefined;
  if (timeoutValue && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
    process.stderr.write('wendkeep mcp: --timeout-ms must be an integer from 1 to 120000\n');
    return 2;
  }
  const explicitVault = optionValue(argv, '--vault');
  const vaultBase = explicitVault
    ? (isAbsolute(explicitVault) ? resolve(explicitVault) : resolve(process.cwd(), explicitVault))
    : '';
  const auditors = new Map();
  const auditToolCall = async (event, { projectRoot = '' } = {}) => {
    let selectedVault = vaultBase;
    if (!selectedVault && projectRoot) {
      selectedVault = resolveProjectVault({ startDir: projectRoot }).base;
    }
    if (!selectedVault) return;
    if (!auditors.has(selectedVault)) auditors.set(selectedVault, createMcpAuditor(selectedVault));
    await auditors.get(selectedVault)(event);
  };
  const server = createNativeMcpServer({
    executeTool: executeNativeMcpTool,
    auditToolCall,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  await runNativeMcpStdio({ server });
  return 0;
}
