import { isAbsolute, resolve } from 'node:path';
import { readControl, readSessionRegistry, writeControl } from '../hooks/obsidian-common.mjs';

function vaultOf(argv) {
  const i = argv.indexOf('--vault');
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--vault='))?.slice(8) || process.env.OBSIDIAN_VAULT_PATH;
  if (!raw) throw new Error('pass --vault <path> or set OBSIDIAN_VAULT_PATH');
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function positionals(argv) {
  return argv.filter((arg, index) => !arg.startsWith('-') && argv[index - 1] !== '--vault');
}

export function runSession(argv) {
  const vault = vaultOf(argv);
  const [sub, id] = positionals(argv);
  const registry = readSessionRegistry(vault);
  const rows = Object.entries(registry.sessions || {}).sort((a, b) => String(b[1].last_seen || '').localeCompare(String(a[1].last_seen || '')));
  if (sub === 'list') {
    for (const [sessionId, item] of rows) process.stdout.write(`${sessionId}\t${item.status || 'unknown'}\t${item.provider || 'unknown'}\t${item.change_slug || '-'}\t${item.session_file || '-'}\n`);
    return;
  }
  const entry = registry.sessions?.[id];
  if (!entry) throw new Error(`session not found: ${id || '(missing id)'}`);
  if (sub === 'show') {
    process.stdout.write(`${JSON.stringify({ session_id: id, ...entry }, null, 2)}\n`);
    return;
  }
  if (sub === 'use') {
    const control = readControl(vault);
    writeControl(vault, { ...control, status: entry.status || 'active', session_id: id, session_file: entry.session_file || '', started_at: entry.started_at || '' });
    process.stdout.write(`session focus: ${id}\n`);
    return;
  }
  throw new Error('use: wendkeep session list | show <id> | use <id>');
}
