import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryDocumentViewModel,
  filterMemoryDocuments,
  loadMemoryDocument,
  loadProjectMemory,
  memoryCategory,
  parseObserverRoute,
} from '../web/observer/app.mjs';

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test('[req:MEM-UI-7] rotas do Observer distinguem overview, workspace, documento e busca', () => {
  assert.deepEqual(parseObserverRoute(''), { kind: 'overview' });
  assert.deepEqual(parseObserverRoute('#project/project-a/sessions'), {
    kind: 'project', projectId: 'project-a', section: 'sessions',
  });
  assert.deepEqual(parseObserverRoute('#document/project-a/02-Sessões%2Fsession.md'), {
    kind: 'document', projectId: 'project-a', logicalPath: '02-Sessões/session.md',
  });
  assert.deepEqual(parseObserverRoute('#search?q=conflito'), {
    kind: 'search', query: 'conflito',
  });
});

test('[req:MEM-UI-7] categorias e filtro representam documentos completos', () => {
  assert.equal(memoryCategory('02-Sessões/2026/session.md'), 'Sessões');
  assert.equal(memoryCategory('04-Decisões/ADR.md'), 'Decisões');
  assert.equal(memoryCategory('08-Mudanças/example/proposta.md'), 'Changes');
  const documents = [
    { logical_path: '02-Sessões/session.md', entity_type: 'session', content_hash: 'a' },
    { logical_path: '05-Bugs/BUG-0001.md', entity_type: 'bug', content_hash: 'b' },
  ];
  assert.deepEqual(filterMemoryDocuments(documents, 'bug').map((item) => item.logical_path), ['05-Bugs/BUG-0001.md']);
  assert.deepEqual(buildMemoryDocumentViewModel(documents[0], '# Sessão\n\nConteúdo integral.'), {
    title: 'session',
    category: 'Sessões',
    logicalPath: '02-Sessões/session.md',
    content: '# Sessão\n\nConteúdo integral.',
    hash: 'a',
    entityType: 'session',
    revision: 0,
    sourceSessionId: '',
    capturedAt: '',
  });
});

test('[req:MEM-UI-7] cliente carrega árvore, sincronização e documento sem token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/memory/tree')) return jsonResponse({ project_id: 'project-a', documents: [], document_count: 0, categories: [] });
    if (url.endsWith('/sync')) return jsonResponse({ project_id: 'project-a', mode: 'mirror', document_count: 0 });
    return jsonResponse({ logical_path: '02-Sessões/session.md', content: '# sessão', content_hash: 'a', revision: 1 });
  };
  const memory = await loadProjectMemory(fetchImpl, 'project-a');
  const document = await loadMemoryDocument(fetchImpl, 'project-a', '02-Sessões/session.md');
  assert.equal(memory.sync.mode, 'mirror');
  assert.equal(document.content, '# sessão');
  assert.equal(calls.every((call) => !Object.hasOwn(call.options.headers, 'Authorization')), true);
});
