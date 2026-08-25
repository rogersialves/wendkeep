import { HOST_CAPABILITY_MANIFESTS } from '../packages/integrations/src/capabilities.mjs';
import { buildHostCoverage } from './host-capabilities.mjs';

export const CAPABILITIES_HELP = `wendkeep capabilities [options]

  --host <id>            claude | codex | pi | generic-mcp (default: all)
  --host-version <v>     observed host version for support classification
  --json                 structured coverage
`;

function option(argv, name) {
  const rows = argv.filter((item) => item === name || item.startsWith(`${name}=`));
  if (rows.length > 1) throw Object.assign(new Error(`${name} must be supplied once`), { code: 'HOST_ARGUMENT_INVALID' });
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

export function runCapabilities(argv = []) {
  const json = argv.includes('--json');
  try {
    const known = new Set(['--host', '--host-version', '--json']);
    for (let index = 0; index < argv.length; index += 1) {
      const item = argv[index];
      const flag = item.split('=', 1)[0];
      if (!known.has(flag)) throw Object.assign(new Error(`unknown option: ${item}`), { code: 'HOST_ARGUMENT_INVALID' });
      if (['--host', '--host-version'].includes(item)) {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
          throw Object.assign(new Error(`${item} requires a value`), { code: 'HOST_ARGUMENT_INVALID' });
        }
        index += 1;
      }
    }
    const host = option(argv, '--host');
    const hostVersion = option(argv, '--host-version');
    const ids = host ? [host] : Object.keys(HOST_CAPABILITY_MANIFESTS);
    const rows = ids.map((hostId) => buildHostCoverage({ hostId, hostVersion }));
    const payload = host ? rows[0] : { schema_version: 1, hosts: rows };
    if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else for (const coverage of rows) {
      process.stdout.write(`${coverage.host_id}: ${coverage.degraded ? 'degraded' : 'complete'}\n`);
      for (const item of coverage.capabilities) process.stdout.write(`  ${item.capability}: ${item.state} (${item.authority})\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`wendkeep capabilities: ${error?.code || 'HOST_CAPABILITIES_FAILED'}: ${error?.message || error}\n`);
    return 2;
  }
}
