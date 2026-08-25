import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function makeObserverFixture({
  projectId = 'project-a',
  projectName = 'Project A',
  slug = 'change-a',
  openTasks = ['1.1 Implement observer'],
  doneTasks = [],
  hostCoverage = null,
} = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'wk-observer-project-'));
  const vaultBase = join(projectRoot, '.WendKeep-vault');
  const brain = join(vaultBase, '.brain');
  const changeDir = join(vaultBase, '08-Mudanças', slug);
  mkdirSync(brain, { recursive: true });
  mkdirSync(changeDir, { recursive: true });

  writeFileSync(join(brain, 'PROJECT.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    projectName,
  }, null, 2)}\n`);
  writeFileSync(join(brain, 'CURRENT_SESSION.md'), [
    '---',
    'status: "inactive"',
    'session_file: ""',
    'last_session_file: ""',
    'session_id: "fixture-session"',
    '---',
    '',
    '# CURRENT_SESSION',
    '',
  ].join('\n'));
  writeFileSync(join(brain, 'SESSION_REGISTRY.json'), JSON.stringify({
    version: 2,
    sessions: {
      'fixture-session': {
        status: 'done',
        session_file: '02-Sessões/2026/08-AGO/DIA 16/fixture.md',
        provider: 'codex',
        last_seen: '2026-08-16T11:00:00Z',
        change_slug: slug,
        ...(hostCoverage ? { host_coverage: hostCoverage } : {}),
      },
    },
  }, null, 2));
  writeFileSync(join(changeDir, 'proposta.md'), `---\ntype: change\n---\n# ${slug}\n`);
  const taskLines = [
    ...doneTasks.map((task, index) => `- [x] ${index + 1}.1 ${task}`),
    ...openTasks.map((task, index) => `- [ ] ${doneTasks.length + index + 1}.1 ${task}`),
  ];
  writeFileSync(join(changeDir, 'tarefas.md'), `${taskLines.join('\n')}\n`);

  return {
    projectRoot,
    vaultBase,
    projectId,
    projectName,
    cleanup() { rmSync(projectRoot, { recursive: true, force: true }); },
  };
}

export function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'wk-observer-data-'));
}
