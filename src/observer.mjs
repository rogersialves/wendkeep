import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { appendObserverEvent, readObserverIndex, registerObserverProject } from './observer-store.mjs';
import { buildProjectSnapshot } from './observer-snapshot.mjs';
import { compareMemoryParity, publishObserverMemory } from './observer-memory-publish.mjs';
import { startObserverServer } from './observer-server.mjs';
import { resolveProjectVault } from '../packages/vault/src/project-vault.mjs';

export const OBSERVER_HELP = `wendkeep observer — Observer local multi-projeto

Uso:
  wendkeep observer serve [--data-dir P] [--host 127.0.0.1] [--port 8787]
                          [--allow-non-loopback]
  wendkeep observer register --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer publish --project P [--vault V] [--data-dir D] [--json]
  wendkeep observer memory import --project P [--vault V] [--url U] [--json]
  wendkeep observer status [--data-dir D] [--json]

O Observer local pode manter snapshots operacionais e uma cópia completa da memória em volume
Docker. O comando memory import faz a primeira migração de um vault para o container.
`;

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function dataDir(argv) {
  return resolve(optionValue(argv, '--data-dir')
    || process.env.WENDKEEP_OBSERVER_DATA_DIR
    || `${homedir()}/.wendkeep-observer`);
}

function projectRoot(argv) {
  const value = optionValue(argv, '--project') || process.cwd();
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function vaultBase(argv, root) {
  const explicit = optionValue(argv, '--vault');
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : resolve(root, explicit);
  return resolveProjectVault({ startDir: root }).base;
}

function print(value, asJson, write = (chunk) => process.stdout.write(chunk)) {
  write((asJson ? JSON.stringify(value, null, 2) : String(value)) + '\n');
}

function summary(index) {
  return {
    schema_version: index.schema_version,
    projects: index.projects.map(({ snapshot, ...item }) => item),
  };
}

export async function runObserver(argv = [], { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const [sub] = argv;
  const asJson = argv.includes('--json');
  if (!sub || sub === 'help') {
    process.stdout.write(OBSERVER_HELP);
    return 0;
  }
  const dir = dataDir(argv);

  if (sub === 'status') {
    print(summary(readObserverIndex(dir)), asJson, write);
    return 0;
  }

  if (sub === 'serve') {
    const host = optionValue(argv, '--host') || '127.0.0.1';
    const server = await startObserverServer({
      dataDir: dir,
      host,
      port: Number(optionValue(argv, '--port') || 8787),
      allowNonLoopback: argv.includes('--allow-non-loopback'),
    });
    const address = server.address();
    process.stdout.write(`wendkeep observer listening: http://${address.address}:${address.port}\n`);
    return 0;
  }

  if (sub === 'memory') {
    const action = argv[1] || '';
    if (action !== 'import') throw new Error('observer memory: use memory import.');
    const root = projectRoot(argv);
    const vault = vaultBase(argv, root);
    const snapshot = buildProjectSnapshot({ vaultBase: vault, projectRoot: root });
    const url = optionValue(argv, '--url') || process.env.WENDKEEP_OBSERVER_URL || '';
    if (!url) throw new Error('observer memory import: --url ou WENDKEEP_OBSERVER_URL é obrigatório.');
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    const registration = await fetch(
      String(url).replace(/\/$/, '') + '/v1/projects/' + encodeURIComponent(snapshot.project_id),
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          project_id: snapshot.project_id,
          project_name: snapshot.project_name,
          wendkeep_version: snapshot.wendkeep_version,
        }),
      },
    );
    if (!registration.ok) throw new Error('Observer não registrou o projeto: HTTP ' + registration.status + '.');
    const memory = await publishObserverMemory({
      vaultBase: vault,
      projectId: snapshot.project_id,
      url,
    });
    const parity = await compareMemoryParity({
      vaultBase: vault,
      projectId: snapshot.project_id,
      url,
    });
    const result = {
      ok: memory.ok && parity.missing === 0 && parity.mismatched === 0,
      project_id: snapshot.project_id,
      memory,
      parity,
    };
    print(result, asJson, write);
    return result.ok ? 0 : 1;
  }

  if (!['register', 'publish'].includes(sub)) throw new Error('observer: subcomando desconhecido: ' + sub);
  const root = projectRoot(argv);
  const vault = vaultBase(argv, root);
  const snapshot = buildProjectSnapshot({ vaultBase: vault, projectRoot: root });

  if (sub === 'register') {
    const result = registerObserverProject(dir, {
      projectId: snapshot.project_id,
      projectName: snapshot.project_name,
      wendkeepVersion: snapshot.wendkeep_version,
    });
    if (!result.registered) throw new Error(result.errors.join(' '));
    print(result, asJson, write);
    return 0;
  }

  const result = appendObserverEvent(dir, snapshot);
  if (!result.accepted && !result.duplicate) throw new Error(result.errors.join(' '));
  print({ ok: true, ...result }, asJson, write);
  return 0;
}
