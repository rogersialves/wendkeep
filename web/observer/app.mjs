export const STALE_AFTER_MS = 60_000;
export const REFRESH_INTERVAL_MS = 15_000;
const MEMORY_CATEGORY_LABELS = {
  '02-Sessões': 'Sessões',
  '04-Decisões': 'Decisões',
  '05-Bugs': 'Bugs',
  '06-Aprendizados': 'Aprendizados',
  '07-Specs': 'Specs',
  '08-Mudanças': 'Changes',
  '.brain': 'Core',
};

export function parseObserverRoute(hash = '') {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { kind: 'overview' };
  if (raw.startsWith('search')) {
    const query = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');
    return { kind: 'search', query: query.get('q') || '' };
  }
  const parts = raw.split('/');
  if (parts[0] === 'project' && parts[1]) {
    return { kind: 'project', projectId: decodeURIComponent(parts[1]), section: parts[2] || 'overview' };
  }
  if (parts[0] === 'document' && parts[1] && parts[2]) {
    return {
      kind: 'document',
      projectId: decodeURIComponent(parts[1]),
      logicalPath: decodeURIComponent(parts.slice(2).join('/')),
    };
  }
  return { kind: 'overview' };
}

export function memoryCategory(logicalPath = '') {
  return MEMORY_CATEGORY_LABELS[String(logicalPath).split('/')[0]] || 'Memória';
}

export function filterMemoryDocuments(documents = [], filter = '') {
  const query = String(filter || '').trim().toLowerCase();
  if (!query) return [...documents];
  return documents.filter((item) => [
    item.logical_path, item.entity_type, memoryCategory(item.logical_path),
  ].join(' ').toLowerCase().includes(query));
}

export function buildMemoryDocumentViewModel(metadata = {}, content = '') {
  const logicalPath = String(metadata.logical_path || '');
  const parts = logicalPath.split('/');
  return {
    title: (parts.at(-1) || 'Documento').replace(/\.[^.]+$/, ''),
    category: memoryCategory(logicalPath),
    logicalPath,
    content: String(content || ''),
    hash: String(metadata.content_hash || ''),
    entityType: String(metadata.entity_type || 'memory'),
    revision: Number(metadata.revision || 0),
    sourceSessionId: String(metadata.source_session_id || ''),
    capturedAt: String(metadata.captured_at || ''),
  };
}

export function isSnapshotStale(capturedAt, now = new Date()) {
  const captured = Date.parse(String(capturedAt || ''));
  const current = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return !Number.isFinite(captured) || !Number.isFinite(current) || current - captured > STALE_AFTER_MS;
}

export function classifyRefreshError(error = {}, hasModels = false) {
  return {
    kind: hasModels ? 'degraded' : 'unavailable',
    message: hasModels
      ? `Não foi possível atualizar. Última leitura preservada. ${error.message || 'erro desconhecido.'}`
      : `Observer indisponível. ${error.message || 'erro desconhecido.'}`,
    preserve: hasModels,
  };
}

async function requestJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error(`Observer respondeu HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function loadProjectMemory(fetchImpl = globalThis.fetch, projectId = '') {
  const id = encodeURIComponent(projectId);
  const [tree, sync] = await Promise.all([
    requestJson(fetchImpl, '/v1/projects/' + id + '/memory/tree'),
    requestJson(fetchImpl, '/v1/projects/' + id + '/sync'),
  ]);
  return { tree, sync };
}

export function usageQuery(filters = {}) {
  const params = new URLSearchParams();
  const keys = ['from', 'to', 'agent_id', 'subagent_id', 'provider', 'model_provider', 'model', 'change', 'session_id', 'role'];
  for (const key of keys) {
    const value = filters[key] ?? filters[key.replace('_id', 'Id')] ?? '';
    if (String(value).trim()) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function loadProjectUsage(fetchImpl = globalThis.fetch, projectId = '', filters = {}) {
  const id = encodeURIComponent(projectId);
  const query = usageQuery(filters);
  const [summary, breakdown, calls] = await Promise.all([
    requestJson(fetchImpl, `/v1/projects/${id}/usage/summary${query}`),
    requestJson(fetchImpl, `/v1/projects/${id}/usage/breakdown${query}`),
    requestJson(fetchImpl, `/v1/projects/${id}/usage/calls${query}`),
  ]);
  return { summary, breakdown, calls, filters: { ...filters } };
}

export function buildUsageViewModel(usage = {}) {
  const summary = usage.summary || {};
  const agents = (Array.isArray(usage.breakdown?.agents) ? usage.breakdown.agents : []).map((agent) => ({ ...agent, children: [] }));
  const byId = new Map(agents.map((agent) => [agent.agent_id, agent]));
  for (const agent of agents) {
    const parent = agent.parent_agent_id ? byId.get(agent.parent_agent_id) : null;
    if (parent && parent !== agent) parent.children.push(agent);
  }
  const roots = agents.filter((agent) => !agent.parent_agent_id || !byId.has(agent.parent_agent_id));
  const tokens = {
    input: Number(summary.tokens?.input || 0),
    cacheWrite: Number(summary.tokens?.cache_write || 0),
    cacheRead: Number(summary.tokens?.cache_read || 0),
    output: Number(summary.tokens?.output || 0),
    reasoning: Number(summary.tokens?.reasoning || 0),
    total: Number(summary.tokens?.total || 0),
  };
  const coverage = summary.coverage || {};
  const complete = Number(coverage.complete || 0);
  const summaryOnly = Number(coverage.summary_only || 0);
  return {
    totalCost: Number(summary.cost_usd || 0),
    mainCost: Number(summary.main_cost_usd || 0),
    subagentCost: Number(summary.subagent_cost_usd || 0),
    wastedCost: Number(summary.wasted_usd || 0),
    calls: Array.isArray(usage.calls?.calls) ? usage.calls.calls : [],
    callCount: Number(summary.calls || usage.calls?.total || 0),
    sessions: Number(summary.sessions || 0),
    agentsCount: Number(summary.agents || 0),
    subagentsCount: Number(summary.subagents || 0),
    modelsCount: Number(summary.models || 0),
    tokens,
    trend: Array.isArray(summary.by_day) ? summary.by_day : [],
    agents: roots,
    allAgents: agents,
    coverage: {
      complete,
      summaryOnly,
      total: Number(coverage.transcripts || complete + summaryOnly),
      label: `${complete} completo${complete === 1 ? '' : 's'} · ${summaryOnly} agregado${summaryOnly === 1 ? '' : 's'}`,
    },
    hasUnknownPricing: Number(summary.unknown_priced_rollups || 0) > 0,
  };
}

export async function loadMemoryDocument(fetchImpl = globalThis.fetch, projectId = '', logicalPath = '') {
  const query = new URLSearchParams({ path: logicalPath });
  return requestJson(fetchImpl, '/v1/projects/' + encodeURIComponent(projectId) + '/memory/document?' + query.toString());
}

export async function loadProjectTranscript(fetchImpl = globalThis.fetch, projectId = '', transcriptId = '') {
  return requestJson(fetchImpl, `/v1/projects/${encodeURIComponent(projectId)}/transcripts/${encodeURIComponent(transcriptId)}`);
}

export async function searchProjectMemory(fetchImpl = globalThis.fetch, projectId = '', query = '') {
  const params = new URLSearchParams({ q: query });
  return requestJson(fetchImpl, '/v1/projects/' + encodeURIComponent(projectId) + '/memory/search?' + params.toString());
}

export async function loadDashboardData(fetchImpl = globalThis.fetch) {
  const index = await requestJson(fetchImpl, '/v1/projects');
  const projects = Array.isArray(index?.projects) ? index.projects : [];
  return Promise.all(projects.map(async (summary) => {
    const detail = await requestJson(fetchImpl, `/v1/projects/${encodeURIComponent(summary.projectId)}`);
    return buildProjectViewModel(summary, detail, new Date());
  }));
}

export function buildProjectViewModel(summary = {}, detail = {}, now = new Date()) {
  const snapshot = detail.snapshot || {};
  const session = snapshot.session || {};
  const health = snapshot.health || {};
  const changes = Array.isArray(snapshot.changes) ? snapshot.changes : [];
  return {
    projectId: String(summary.projectId || detail.projectId || snapshot.project_id || ''),
    projectName: String(summary.projectName || detail.projectName || snapshot.project_name || 'Projeto sem nome'),
    version: String(snapshot.wendkeep_version || summary.wendkeepVersion || '—'),
    eventCount: Number(detail.eventCount || summary.eventCount || 0),
    capturedAt: String(snapshot.captured_at || detail.capturedAt || ''),
    stale: isSnapshotStale(snapshot.captured_at || detail.capturedAt, now),
    session: {
      status: String(session.status || 'inactive'),
      provider: String(session.provider || '—'),
      changeSlug: String(session.change_slug || '—'),
      lastSeen: String(session.last_seen || '—'),
    },
    health: {
      ok: health.ok === true,
      status: String(health.status || 'unavailable'),
      failureCount: Number(health.failure_count || 0),
      warningCount: Number(health.warning_count || 0),
      registrySessions: Number(health.registry_sessions || 0),
      derivedNotes: Number(health.derived_notes || 0),
    },
    changes: changes.map((change) => ({
      slug: String(change.slug || '—'),
      current: change.current === true,
      openTasks: Number(change.openTasks || 0),
      doneTasks: Number(change.doneTasks || 0),
      warning: String(change.warning || ''),
    })),
  };
}

export function filterProjects(models = [], filter = '') {
  const query = String(filter || '').trim().toLowerCase();
  if (!query) return [...models];
  return models.filter((model) => [
    model.projectId, model.projectName, model.version, model.session?.provider,
    model.session?.changeSlug, model.health?.status, statusLabel(model),
  ].join(' ').toLowerCase().includes(query));
}

function byId(id) { return document.getElementById(id); }
function setHidden(element, hidden) { if (element) element.hidden = hidden; }
function text(element, value) { if (element) element.textContent = String(value ?? ''); }
function node(tag, className, content = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== '') element.textContent = String(content);
  return element;
}
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'sem captura registrada';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function statusClass(model) {
  if (!model.health.ok || model.health.failureCount > 0) return 'is-danger';
  if (model.stale || model.health.warningCount > 0) return 'is-warning';
  return 'is-healthy';
}
function statusLabel(model) {
  if (!model.health.ok || model.health.failureCount > 0) return 'degradado';
  if (model.stale) return 'stale';
  if (model.health.warningCount > 0) return 'atenção';
  return 'saudável';
}

function renderMetrics(models) {
  const target = byId('metrics-grid');
  if (!target) return;
  const healthy = models.filter((model) => model.health.ok && !model.stale).length;
  const active = models.filter((model) => model.session.status === 'active').length;
  const openChanges = models.reduce((sum, model) => sum + model.changes.filter((change) => change.openTasks > 0).length, 0);
  const metrics = [
    ['Projetos', models.length, 'snapshots registrados'],
    ['Saudáveis', healthy, healthy === models.length ? 'todos os sinais verdes' : 'requer atenção'],
    ['Sessões ativas', active, active === 1 ? 'uma sessão em andamento' : 'sessões em andamento'],
    ['Changes abertas', openChanges, 'com tarefas pendentes'],
  ];
  target.replaceChildren(...metrics.map(([label, value, caption]) => {
    const card = node('article', 'metric');
    card.append(node('span', 'metric-label', label), node('strong', 'metric-value', value), node('span', 'metric-caption', caption));
    return card;
  }));
}

function renderProjectList(models, selectedId, filter) {
  const list = byId('project-list');
  const empty = byId('empty-state');
  if (!list || !empty) return;
  const visible = filterProjects(models, filter);
  list.replaceChildren(...visible.map((model) => {
    const item = node('button', `project-item${model.projectId === selectedId ? ' is-selected' : ''}`);
    item.type = 'button';
    item.dataset.projectId = model.projectId;
    item.setAttribute('aria-label', `${model.projectName}, ${statusLabel(model)}`);
    const dot = node('span', `project-status ${statusClass(model)}`);
    dot.setAttribute('aria-hidden', 'true');
    const copy = node('span');
    copy.append(node('span', 'project-title', model.projectName), node('span', 'project-meta', `${model.version} · ${model.session.provider}`));
    item.append(dot, copy, node('span', 'project-count', `${model.changes.length} changes`));
    item.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('observer:select-project', { detail: model.projectId }));
    });
    return item;
  }));
  setHidden(empty, visible.length > 0);
  if (visible.length === 0) setHidden(empty, false);
}

function renderDetail(model) {
  const panel = byId('project-detail');
  if (!panel) return;
  if (!model) {
    panel.replaceChildren(node('div', 'detail-placeholder'));
    const placeholder = panel.firstElementChild;
    placeholder.append(node('span', 'detail-glyph', '✦'), node('p', 'eyebrow', 'PROJECT DETAIL'), node('h2', '', 'Selecione um projeto'), node('p', '', 'Saúde, sessão e changes aparecem aqui quando você escolher um ponto da constelação.'));
    return;
  }
  const header = node('div', 'detail-header');
  const title = node('div');
  title.append(node('p', 'eyebrow', 'PROJECT DETAIL'), node('h2', '', model.projectName));
  const badge = node('span', `health-badge ${statusClass(model)}`, statusLabel(model));
  header.append(title, badge);
  const facts = node('div', 'detail-facts');
  facts.append(
    fact('Versão', model.version),
    fact('Sessão', `${model.session.status} · ${model.session.provider}`),
    fact('Último snapshot', formatDate(model.capturedAt)),
  );
  const changeHeading = node('div', 'change-heading');
  changeHeading.append(node('h3', '', 'Changes e tarefas'), node('span', '', `${model.changes.length} registradas`));
  const changeList = node('div', 'change-list');
  if (model.changes.length === 0) {
    changeList.append(node('p', 'muted', 'Nenhuma change publicada neste snapshot.'));
  } else {
    for (const change of model.changes) {
      const item = node('div', 'change-item');
      const indicator = node('span', `change-indicator${change.current ? ' is-current' : ''}`);
      indicator.setAttribute('aria-hidden', 'true');
      const copy = node('span');
      copy.append(node('span', 'change-name', change.slug));
      if (change.warning) copy.append(node('span', 'change-warning', change.warning));
      item.append(indicator, copy, node('span', 'change-tasks', `${change.openTasks} abertas · ${change.doneTasks} feitas`));
      changeList.append(item);
    }
  }
  const openWorkspace = node('a', 'workspace-open', 'Abrir workspace da memória →');
  openWorkspace.href = '#project/' + encodeURIComponent(model.projectId) + '/overview';
  panel.replaceChildren(header, facts, openWorkspace, changeHeading, changeList);
  if (model.stale) panel.append(node('p', 'stale-note', '○ Snapshot desatualizado — aguardando novo evento do hook.'));
}

function fact(label, value) {
  const item = node('div', 'fact');
  item.append(node('span', 'fact-label', label), node('span', 'fact-value', value));
  return item;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function markdownHtml(content) {
  return String(content || '').split(/\r?\n/).map((line) => {
    const escaped = escapeHtml(line);
    if (line.startsWith('### ')) return '<h4>' + escaped.slice(4) + '</h4>';
    if (line.startsWith('## ')) return '<h3>' + escaped.slice(3) + '</h3>';
    if (line.startsWith('# ')) return '<h2>' + escaped.slice(2) + '</h2>';
    if (line.startsWith('- ')) return '<li>' + escaped.slice(2) + '</li>';
    if (!line.trim()) return '<div class="markdown-gap" aria-hidden="true"></div>';
    return '<p>' + escaped + '</p>';
  }).join('');
}

function documentHref(projectId, logicalPath) {
  return '#document/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(logicalPath);
}

function documentRow(projectId, document) {
  const link = node('a', 'memory-document-row');
  link.href = documentHref(projectId, document.logical_path);
  const title = String(document.logical_path || '').split('/').at(-1) || 'Documento';
  link.append(
    node('span', 'memory-document-glyph', memoryCategory(document.logical_path).slice(0, 1)),
    node('span', 'memory-document-copy'),
    node('span', 'memory-document-size', String(Number(document.bytes || 0)) + ' B'),
  );
  link.querySelector('.memory-document-copy').append(
    node('strong', '', title.replace(/\.[^.]+$/, '')),
    node('span', 'memory-document-meta', memoryCategory(document.logical_path) + ' · revisão ' + (document.revision || 0)),
  );
  return link;
}

function renderDocumentRows(container, projectId, documents, emptyMessage = 'Nenhum documento encontrado.') {
  if (!documents.length) {
    container.replaceChildren(node('p', 'muted', emptyMessage));
    return;
  }
  container.replaceChildren(...documents.map((document) => documentRow(projectId, document)));
}

function renderWorkspaceOverview(container, model, memory) {
  const title = node('div', 'workspace-section-heading');
  title.append(node('p', 'eyebrow', 'PROJECT OVERVIEW'), node('h2', '', 'Memória em um só lugar'));
  const facts = node('div', 'detail-facts');
  facts.append(
    fact('Documentos', memory?.tree?.document_count || 0),
    fact('Eventos', memory?.sync?.event_count || 0),
    fact('Última sessão', model?.session?.provider || '—'),
  );
  const intro = node('div', 'workspace-intro');
  intro.append(
    node('p', '', 'O container mantém a cópia completa deste projeto. Navegue pelas sessões, notas e mudanças sem sair do Observer.'),
    node('p', 'muted', 'Último evento: ' + formatDate(memory?.sync?.last_event_at)),
  );
  container.replaceChildren(title, facts, intro);
}

function renderSessions(container, projectId, documents) {
  const heading = node('div', 'workspace-section-heading');
  heading.append(node('p', 'eyebrow', 'SESSION ARCHIVE'), node('h2', '', 'Sessões'));
  const filters = node('div', 'memory-filter-strip');
  filters.append(node('span', 'filter-chip is-active', 'Todas'), node('span', 'filter-chip', 'Ativas'), node('span', 'filter-chip', 'Codex'), node('span', 'filter-chip', 'Claude'));
  const list = node('div', 'memory-document-list');
  renderDocumentRows(list, projectId, documents.filter((item) => item.logical_path.startsWith('02-Sessões/')), 'Nenhuma sessão foi sincronizada.');
  container.replaceChildren(heading, filters, list);
}

function renderMemory(container, projectId, documents) {
  const heading = node('div', 'workspace-section-heading');
  heading.append(node('p', 'eyebrow', 'CANONICAL MEMORY'), node('h2', '', 'Memória'));
  const categories = node('div', 'category-strip');
  const counts = new Map();
  for (const document of documents) {
    const label = memoryCategory(document.logical_path);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  for (const [label, count] of counts) categories.append(node('span', 'category-chip', label + ' ' + count));
  const search = node('label', 'memory-inline-search');
  search.append(node('span', 'sr-only', 'Filtrar documentos'));
  const input = node('input');
  input.type = 'search';
  input.placeholder = 'Filtrar documentos';
  search.append(input);
  const list = node('div', 'memory-document-list');
  renderDocumentRows(list, projectId, documents);
  input.addEventListener('input', () => renderDocumentRows(list, projectId, filterMemoryDocuments(documents, input.value)));
  container.replaceChildren(heading, categories, search, list);
}

function renderChanges(container, projectId, documents) {
  const heading = node('div', 'workspace-section-heading');
  heading.append(node('p', 'eyebrow', 'CHANGE LEDGER'), node('h2', '', 'Changes'));
  const list = node('div', 'memory-document-list');
  renderDocumentRows(list, projectId, documents.filter((item) => item.logical_path.startsWith('08-Mudanças/')), 'Nenhuma change foi sincronizada.');
  container.replaceChildren(heading, list);
}

function renderSync(container, sync, projectId = '') {
  const heading = node('div', 'workspace-section-heading');
  heading.append(node('p', 'eyebrow', 'SYNC CONTROL'), node('h2', '', 'Sincronização'));
  const facts = node('div', 'detail-facts');
  facts.append(
    fact('Modo', sync?.mode || 'indisponível'),
    fact('Pendentes', sync?.pending_count || 0),
    fact('Conflitos', sync?.conflict_count || 0),
  );
  const note = node('div', 'sync-callout', sync?.conflict_count ? 'Existem conflitos que exigem revisão.' : 'A memória local está acompanhando o container.');
  const exportLink = node('a', 'workspace-open', 'Exportar cópia read-only →');
  exportLink.href = '/v1/projects/' + encodeURIComponent(projectId) + '/memory/export';
  exportLink.target = '_blank';
  exportLink.rel = 'noopener';
  container.replaceChildren(heading, facts, note, exportLink);
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
}

function formatUsd(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 4 }).format(Number(value) || 0);
}

function usageFilter(label, name, value, type = 'text') {
  const wrapper = node('label', 'usage-filter');
  wrapper.append(node('span', '', label));
  const input = node('input');
  input.name = name;
  input.type = type;
  input.value = String(value || '');
  wrapper.append(input);
  return wrapper;
}

function usageSelect(label, name, value, options) {
  const wrapper = node('label', 'usage-filter');
  wrapper.append(node('span', '', label));
  const select = node('select');
  select.name = name;
  for (const [optionValue, optionLabel] of options) {
    const option = node('option', '', optionLabel);
    option.value = optionValue;
    option.selected = optionValue === String(value || '');
    select.append(option);
  }
  wrapper.append(select);
  return wrapper;
}

function renderUsage(container, projectId, usage, { onFiltersChanged, onTranscript } = {}) {
  const view = buildUsageViewModel(usage);
  const filters = usage?.filters || {};
  const heading = node('div', 'workspace-section-heading');
  heading.append(node('p', 'eyebrow', 'PROJECT CONSUMPTION'), node('h2', '', 'Consumo'));

  const filterForm = node('form', 'usage-filters');
  filterForm.append(
    usageFilter('De', 'from', filters.from, 'date'),
    usageFilter('Até', 'to', filters.to, 'date'),
    usageSelect('Escopo', 'role', filters.role, [['', 'Principal + subagentes'], ['main', 'Principal'], ['subagent', 'Subagentes']]),
    usageFilter('Agente', 'agent_id', filters.agent_id || filters.agentId),
    usageFilter('Subagente', 'subagent_id', filters.subagent_id || filters.subagentId),
    usageFilter('Provedor', 'provider', filters.provider),
    usageFilter('Provedor do modelo', 'model_provider', filters.model_provider || filters.modelProvider),
    usageFilter('Modelo', 'model', filters.model),
    usageFilter('Change', 'change', filters.change || filters.changeSlug),
    usageFilter('Sessão', 'session_id', filters.session_id || filters.sessionId),
    node('button', 'button-primary', 'Aplicar filtros'),
  );
  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(filterForm);
    onFiltersChanged?.({
      from: form.get('from') || '', to: form.get('to') || '', role: form.get('role') || '',
      agent_id: form.get('agent_id') || '', subagent_id: form.get('subagent_id') || '',
      provider: form.get('provider') || '', model_provider: form.get('model_provider') || '', model: form.get('model') || '',
      change: form.get('change') || '', session_id: form.get('session_id') || '',
    });
  });

  const cards = node('div', 'usage-summary-grid');
  const summaryCards = [
    ['Custo total', formatUsd(view.totalCost), `${formatUsd(view.mainCost)} principal · ${formatUsd(view.subagentCost)} subagentes`],
    ['Tokens', formatNumber(view.tokens.total), `entrada ${formatNumber(view.tokens.input)} · saída ${formatNumber(view.tokens.output)}`],
    ['Chamadas', formatNumber(view.callCount), `${formatNumber(view.sessions)} sessões · ${formatNumber(view.modelsCount)} modelos`],
    ['Cobertura', view.coverage.label, `${formatNumber(view.coverage.total)} transcript(s)`],
  ];
  for (const [label, value, caption] of summaryCards) {
    const card = node('article', 'usage-summary-card');
    card.append(node('span', 'metric-label', label), node('strong', 'usage-summary-value', value), node('span', 'metric-caption', caption));
    cards.append(card);
  }

  const content = [];
  if (view.hasUnknownPricing) content.push(node('div', 'usage-warning', 'Há modelos sem tarifa conhecida. Os custos históricos registrados não foram recalculados.'));
  if (view.wastedCost > 0) content.push(node('div', 'usage-callout', `Desperdício registrado em workflows interrompidos: ${formatUsd(view.wastedCost)}.`));

  const tokenPanel = node('section', 'usage-panel');
  tokenPanel.append(node('h3', '', 'Tokens por categoria'));
  const tokenGrid = node('div', 'usage-token-grid');
  for (const [label, value] of [['Entrada', view.tokens.input], ['Cache write', view.tokens.cacheWrite], ['Cache read', view.tokens.cacheRead], ['Saída', view.tokens.output], ['Reasoning', view.tokens.reasoning], ['Total', view.tokens.total]]) {
    tokenGrid.append(fact(label, formatNumber(value)));
  }
  tokenPanel.append(tokenGrid);
  content.push(tokenPanel);

  const trendPanel = node('section', 'usage-panel');
  trendPanel.append(node('h3', '', 'Tendência diária'));
  const trend = node('div', 'usage-trend');
  if (!view.trend.length) trend.append(node('p', 'muted', 'Sem atividade no período selecionado.'));
  else for (const day of view.trend) {
    const row = node('div', 'usage-trend-row');
    row.append(node('span', '', day.date), node('span', '', `${formatNumber(day.tokens_total)} tokens`), node('strong', '', formatUsd(day.cost_usd)));
    trend.append(row);
  }
  trendPanel.append(trend);
  content.push(trendPanel);

  const hierarchy = node('section', 'usage-panel usage-hierarchy');
  hierarchy.append(node('h3', '', 'Agentes, modelos e subagentes'));
  if (!view.agents.length) hierarchy.append(node('p', 'muted', 'Nenhum agente com consumo no período.'));
  const renderAgent = (agent) => {
    const details = node('details', 'usage-agent');
    const summary = node('summary');
    summary.append(node('strong', '', agent.agent_name || agent.agent_id), node('span', 'usage-agent-meta', `${agent.role} · ${formatNumber(agent.tokens_total)} tokens · ${formatUsd(agent.cost_usd)}`));
    details.append(summary);
    const models = node('div', 'usage-model-list');
    for (const model of agent.models || []) {
      const row = node('div', 'usage-model-row');
      row.append(node('span', '', `${model.model_provider || '—'} · ${model.model || 'modelo sem nome'}`), node('span', '', `${formatNumber(model.tokens_total)} tokens`), node('strong', '', formatUsd(model.cost_usd)));
      models.append(row);
    }
    details.append(models);
    for (const child of agent.children || []) details.append(renderAgent(child));
    return details;
  };
  for (const agent of view.agents) hierarchy.append(renderAgent(agent));
  content.push(hierarchy);

  const callsPanel = node('section', 'usage-panel usage-calls');
  callsPanel.append(node('h3', '', 'Chamadas e transcripts'));
  if (!view.calls.length) callsPanel.append(node('p', 'muted', 'Nenhuma chamada individual disponível; históricos agregados aparecem acima.'));
  for (const call of view.calls) {
    const details = node('details', 'usage-call');
    const summary = node('summary');
    summary.append(node('strong', '', call.model || 'modelo sem nome'), node('span', 'usage-agent-meta', `${call.role || 'principal'} · ${formatNumber(call.tokens?.total)} tokens · ${formatUsd(call.cost_usd)}`));
    details.append(summary);
    const copy = node('div', 'usage-call-copy');
    copy.append(node('p', '', `Sessão: ${call.session_id || '—'} · Agente: ${call.agent_id || '—'}`));
    copy.append(node('h4', '', 'Prompt'), node('pre', '', call.prompt || '—'), node('h4', '', 'Resposta'), node('pre', '', call.response || '—'));
    if (call.transcript_id) {
      const transcriptButton = node('button', 'reader-toggle', 'Abrir transcript completo');
      const transcriptTarget = node('pre', 'usage-transcript', 'Carregando transcript…');
      transcriptTarget.hidden = true;
      transcriptButton.addEventListener('click', async () => {
        transcriptTarget.hidden = false;
        if (transcriptTarget.dataset.loaded) return;
        try {
          const transcript = await onTranscript?.(call.transcript_id);
          transcriptTarget.textContent = transcript?.content || 'Transcript vazio.';
          transcriptTarget.dataset.loaded = 'true';
        } catch (error) {
          transcriptTarget.textContent = error.message || 'Transcript indisponível.';
        }
      });
      copy.append(transcriptButton, transcriptTarget);
    }
    details.append(copy);
    callsPanel.append(details);
  }
  content.push(callsPanel);
  container.replaceChildren(heading, filterForm, cards, ...content);
}

function renderReader(container, document) {
  const heading = node('div', 'reader-heading');
  heading.append(node('p', 'eyebrow', document.category), node('h2', '', document.title));
  const meta = node('div', 'reader-meta');
  meta.append(
    node('span', '', document.logicalPath),
    node('span', '', 'revisão ' + document.revision),
    node('span', '', document.hash.slice(0, 12)),
  );
  const toggle = node('button', 'reader-toggle', 'Ver fonte');
  const body = node('article', 'markdown-reader');
  body.innerHTML = markdownHtml(document.content);
  let source = false;
  toggle.addEventListener('click', () => {
    source = !source;
    toggle.textContent = source ? 'Ver renderizado' : 'Ver fonte';
    body.innerHTML = source ? '<pre>' + escapeHtml(document.content) + '</pre>' : markdownHtml(document.content);
  });
  const copy = node('button', 'reader-copy', 'Copiar conteúdo');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(document.content); copy.textContent = 'Copiado'; } catch { copy.textContent = 'Copie manualmente'; }
  });
  const actions = node('div', 'reader-actions');
  actions.append(toggle, copy);
  container.replaceChildren(heading, meta, actions, body);
}

function startDashboardV2() {
  const dashboardPanel = byId('dashboard-panel');
  if (!dashboardPanel) return;
  const workspacePanel = byId('workspace-panel');
  const workspaceContent = byId('workspace-content');
  const state = {
    models: [],
    selectedId: '',
    filter: '',
    memory: new Map(),
    usage: new Map(),
    usageFilters: new Map(),
    route: parseObserverRoute(globalThis.location?.hash || ''),
  };
  const dashboardError = byId('dashboard-error');
  const connectionDot = byId('connection-dot');
  const connectionLabel = byId('connection-label');
  const fetchJson = (...args) => globalThis.fetch(...args);
  const setConnection = (kind, label) => {
    connectionDot?.classList.remove('is-online', 'is-warning', 'is-offline');
    connectionDot?.classList.add(kind);
    text(connectionLabel, label);
  };
  const render = () => {
    setHidden(dashboardPanel, false);
    renderMetrics(state.models);
    renderProjectList(state.models, state.selectedId, state.filter);
    renderDetail(state.models.find((model) => model.projectId === state.selectedId));
    text(byId('last-sync'), 'Última leitura local · ' + new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(new Date()));
  };
  const setWorkspaceHeader = (model, memory, route) => {
    text(byId('workspace-title'), route.kind === 'search' ? 'Busca na memória' : model?.projectName || 'Projeto');
    text(
      byId('workspace-subtitle'),
      route.kind === 'search'
        ? 'Resultados completos no container local.'
        : (model?.projectId || '') + ' · memória canônica do container',
    );
    const sync = memory?.sync || {};
    const badge = byId('workspace-sync-badge');
    if (badge) {
      badge.className = 'sync-badge';
      if (Number(sync.conflict_count || 0) > 0) badge.classList.add('is-warning');
      else if (sync.mode === 'container-authority') badge.classList.add('is-online');
      text(badge, sync.mode || 'sem sincronização');
    }
    const back = byId('workspace-back');
    if (back) back.href = '#overview';
    const meta = byId('workspace-meta');
    if (meta) {
      const tree = memory?.tree || {};
      meta.replaceChildren(
        fact('Documentos', tree.document_count || sync.document_count || 0),
        fact('Eventos', sync.event_count || 0),
        fact('Conflitos', sync.conflict_count || 0),
      );
    }
    document.querySelectorAll('[data-workspace-section]').forEach((link) => {
      const section = link.dataset.workspaceSection;
      link.classList.toggle('is-active', route.kind === 'project' && route.section === section);
      if (model) link.href = '#project/' + encodeURIComponent(model.projectId) + '/' + section;
    });
  };
  const showWorkspaceError = (message) => {
    if (!workspaceContent) return;
    workspaceContent.replaceChildren(node('div', 'workspace-error', message || 'Não foi possível carregar a memória.'));
  };
  const ensureProjectMemory = async (projectId) => {
    if (!state.memory.has(projectId)) state.memory.set(projectId, await loadProjectMemory(fetchJson, projectId));
    return state.memory.get(projectId);
  };
  const ensureProjectUsage = async (projectId) => {
    const filters = state.usageFilters.get(projectId) || {};
    const usage = await loadProjectUsage(fetchJson, projectId, filters);
    state.usage.set(projectId, usage);
    return usage;
  };
  const renderSearchRoute = async (query) => {
    const model = state.models.find((item) => item.projectId === state.selectedId) || state.models[0];
    setHidden(dashboardPanel, true);
    setHidden(workspacePanel, false);
    if (!model) {
      showWorkspaceError('Nenhum projeto registrado para pesquisar.');
      return;
    }
    state.selectedId = model.projectId;
    try {
      const memory = await ensureProjectMemory(model.projectId);
      setWorkspaceHeader(model, memory, { kind: 'search' });
      const heading = node('div', 'workspace-section-heading');
      heading.append(
        node('p', 'eyebrow', 'MEMORY SEARCH'),
        node('h2', '', query ? 'Resultados para “' + query + '”' : 'Buscar na memória'),
      );
      const results = query ? (await searchProjectMemory(fetchJson, model.projectId, query)).results || [] : [];
      const list = node('div', 'memory-document-list');
      renderDocumentRows(list, model.projectId, results, query ? 'Nenhum documento contém esse termo.' : 'Digite um termo para pesquisar.');
      workspaceContent?.replaceChildren(heading, list);
    } catch (error) {
      showWorkspaceError(error.message);
    }
  };
  const renderWorkspaceRoute = async (route) => {
    const model = state.models.find((item) => item.projectId === route.projectId);
    if (!model) {
      setHidden(dashboardPanel, false);
      setHidden(workspacePanel, true);
      return;
    }
    state.selectedId = model.projectId;
    setHidden(dashboardPanel, true);
    setHidden(workspacePanel, false);
    if (workspaceContent) workspaceContent.replaceChildren(node('p', 'muted', 'Carregando memória do container…'));
    try {
      const memory = await ensureProjectMemory(model.projectId);
      setWorkspaceHeader(model, memory, route);
      const documents = memory.tree?.documents || [];
      if (route.kind === 'document') {
        const payload = await loadMemoryDocument(fetchJson, model.projectId, route.logicalPath);
        renderReader(workspaceContent, buildMemoryDocumentViewModel(payload, payload.content));
        return;
      }
      if (route.section === 'usage') {
        const usage = await ensureProjectUsage(model.projectId);
        renderUsage(workspaceContent, model.projectId, usage, {
          onFiltersChanged: (filters) => {
            state.usageFilters.set(model.projectId, filters);
            renderWorkspaceRoute({ ...route });
          },
          onTranscript: (transcriptId) => loadProjectTranscript(fetchJson, model.projectId, transcriptId),
        });
      } else if (route.section === 'sessions') renderSessions(workspaceContent, model.projectId, documents);
      else if (route.section === 'memory') renderMemory(workspaceContent, model.projectId, documents);
      else if (route.section === 'changes') renderChanges(workspaceContent, model.projectId, documents);
      else if (route.section === 'sync') renderSync(workspaceContent, memory.sync, model.projectId);
      else renderWorkspaceOverview(workspaceContent, model, memory);
    } catch (error) {
      showWorkspaceError(error.message);
    }
  };
  const renderRoute = async () => {
    state.route = parseObserverRoute(globalThis.location?.hash || '');
    if (state.route.kind === 'overview') {
      setHidden(dashboardPanel, false);
      setHidden(workspacePanel, true);
      render();
      return;
    }
    if (state.route.kind === 'search') {
      await renderSearchRoute(state.route.query);
      return;
    }
    await renderWorkspaceRoute(state.route);
  };
  const refresh = async () => {
    setConnection('is-warning', 'Sincronizando');
    try {
      const models = await loadDashboardData(fetchJson);
      state.models = models;
      if (!state.selectedId || !models.some((model) => model.projectId === state.selectedId)) state.selectedId = models[0]?.projectId || '';
      setHidden(dashboardError, true);
      render();
      setConnection('is-online', 'Observer online');
      await renderRoute();
    } catch (error) {
      const failure = classifyRefreshError(error, state.models.length > 0);
      setHidden(dashboardError, false);
      text(dashboardError, failure.message);
      setConnection('is-offline', 'Conexão degradada');
      render();
    }
  };
  byId('refresh-button')?.addEventListener('click', refresh);
  byId('project-filter')?.addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderProjectList(state.models, state.selectedId, state.filter);
  });
  byId('global-search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = byId('global-search')?.value?.trim() || '';
    globalThis.location.hash = '#search?q=' + encodeURIComponent(query);
  });
  byId('global-search')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = event.currentTarget.value.trim();
    globalThis.location.hash = '#search?q=' + encodeURIComponent(query);
  });
  window.addEventListener('observer:select-project', (event) => {
    state.selectedId = event.detail;
    globalThis.location.hash = '#project/' + encodeURIComponent(state.selectedId) + '/overview';
  });
  window.addEventListener('hashchange', () => { renderRoute(); });
  globalThis.setInterval(refresh, REFRESH_INTERVAL_MS);
  refresh();
}

if (typeof document !== 'undefined') startDashboardV2();
