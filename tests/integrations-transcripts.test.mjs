import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completedCodexTurnIdsContent,
  parseClaudeTranscriptContent,
  parseCodexTranscriptContent,
  parseTranscriptContent,
  resolveTurnIdentity,
} from '../packages/integrations/src/transcripts.mjs';

const REPO_ROOT = 'C:\\work\\demo';
const VAULT_ROOT = 'C:\\work\\demo\\.WendKeep-vault';
const PARSE_OPTIONS = Object.freeze({ repoRoot: REPO_ROOT, vaultRoot: VAULT_ROOT });
const emptyUsage = () => ({
  input: 0,
  cached: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});
const jsonl = (events) => events.map((event) => (
  typeof event === 'string' ? event : JSON.stringify(event)
)).join('\n');

const CODEX_EVENTS = [
  {
    type: 'session_meta',
    timestamp: '2026-07-29T10:00:00.000Z',
    payload: {
      id: 'rollout-codex-42',
      session_id: 'conversation-codex-42',
      model: 'gpt-5.6-sol',
      model_provider: 'openai',
    },
  },
  '{linha jsonl deliberadamente invalida',
  {
    type: 'turn_context',
    timestamp: '2026-07-29T10:00:01.000Z',
    payload: { turn_id: 'codex-turn-1', model: 'gpt-5.6-sol' },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:00:02.000Z',
    payload: {
      type: 'user_message',
      turn_id: 'codex-turn-1',
      message: '<recommended_plugins>catalogo injetado</recommended_plugins>',
    },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:00:03.000Z',
    payload: {
      type: 'user_message',
      turn_id: 'codex-turn-1',
      message: 'Quais recommended_plugins devo instalar no projeto?',
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:04.000Z',
    payload: {
      type: 'message',
      role: 'user',
      turn_id: 'codex-turn-1',
      content: [{ type: 'input_text', text: 'Leia src/app.mjs antes de responder.' }],
    },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:00:05.000Z',
    payload: {
      type: 'agent_message',
      turn_id: 'codex-turn-1',
      message: 'Vou inspecionar os arquivos.',
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:06.000Z',
    payload: {
      type: 'message',
      role: 'assistant',
      turn_id: 'codex-turn-1',
      content: [{ type: 'output_text', text: 'A inspeção confirmou o contrato.' }],
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:07.000Z',
    payload: {
      type: 'function_call',
      turn_id: 'codex-turn-1',
      name: 'Read',
      arguments: JSON.stringify({ file_path: 'src/helper.mjs' }),
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:08.000Z',
    payload: {
      type: 'function_call',
      turn_id: 'codex-turn-1',
      name: 'apply_patch',
      arguments: '*** Update File: src/app.mjs\n@@\n-old\n+new',
    },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:09.000Z',
    payload: { type: 'tool_search_call', turn_id: 'codex-turn-1' },
  },
  {
    type: 'response_item',
    timestamp: '2026-07-29T10:00:10.000Z',
    payload: { type: 'web_search_call', turn_id: 'codex-turn-1' },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:00:11.000Z',
    payload: {
      type: 'token_count',
      turn_id: 'codex-turn-1',
      info: {
        model: 'gpt-5.6-sol',
        last_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 50,
          reasoning_output_tokens: 10,
          total_tokens: 170,
        },
      },
    },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:05:00.000Z',
    payload: { type: 'task_started', turn_id: 'codex-turn-2' },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:05:01.000Z',
    payload: { type: 'user_message', turn_id: 'codex-turn-2', message: 'Continue para o segundo turno.' },
  },
  {
    type: 'event_msg',
    timestamp: '2026-07-29T10:05:02.000Z',
    payload: { type: 'agent_message', turn_id: 'codex-turn-2', text: 'Segundo turno concluído.' },
  },
];

const CODEX_CONTENT = `${jsonl(CODEX_EVENTS)}\n`;

const EXPECTED_CODEX = {
  provider: 'codex',
  sessionId: 'rollout-codex-42',
  model: 'gpt-5.6-sol',
  latestTurnId: 'codex-turn-2',
  latestUserPrompt: 'Continue para o segundo turno.',
  latestAssistantMessage: 'Segundo turno concluído.',
  userPrompts: [
    'Quais recommended_plugins devo instalar no projeto?',
    'Leia src/app.mjs antes de responder.',
    'Continue para o segundo turno.',
  ],
  assistantMessages: [
    'Vou inspecionar os arquivos.',
    'A inspeção confirmou o contrato.',
    'Segundo turno concluído.',
  ],
  tools: ['Read', 'apply_patch', 'tool_search', 'web_search'],
  consultedFiles: ['src/helper.mjs', 'src/app.mjs'],
  changedFiles: ['src/app.mjs'],
  turns: [
    {
      turnId: 'codex-turn-1',
      timestamp: '2026-07-29T10:00:01.000Z',
      userPrompts: [
        'Quais recommended_plugins devo instalar no projeto?',
        'Leia src/app.mjs antes de responder.',
      ],
      assistantMessages: ['Vou inspecionar os arquivos.', 'A inspeção confirmou o contrato.'],
      tools: ['Read', 'apply_patch', 'tool_search', 'web_search'],
      consultedFiles: ['src/helper.mjs', 'src/app.mjs'],
      changedFiles: ['src/app.mjs'],
      conversation: [
        { role: 'Usuário', text: 'Quais recommended_plugins devo instalar no projeto?' },
        { role: 'Usuário', text: 'Leia src/app.mjs antes de responder.' },
        { role: 'Assistente', text: 'Vou inspecionar os arquivos.' },
        { role: 'Assistente', text: 'A inspeção confirmou o contrato.' },
      ],
      usage: {
        input: 100,
        cached: 20,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 50,
        reasoning: 10,
        total: 170,
      },
      model: 'gpt-5.6-sol',
    },
    {
      turnId: 'codex-turn-2',
      timestamp: '2026-07-29T10:05:00.000Z',
      userPrompts: ['Continue para o segundo turno.'],
      assistantMessages: ['Segundo turno concluído.'],
      tools: [],
      consultedFiles: [],
      changedFiles: [],
      conversation: [
        { role: 'Usuário', text: 'Continue para o segundo turno.' },
        { role: 'Assistente', text: 'Segundo turno concluído.' },
      ],
      usage: emptyUsage(),
      model: '',
    },
  ],
  rawTextForDetection: [
    'Quais recommended_plugins devo instalar no projeto?',
    'Leia src/app.mjs antes de responder.',
    'Continue para o segundo turno.',
    'Vou inspecionar os arquivos.',
    'A inspeção confirmou o contrato.',
    'Segundo turno concluído.',
  ].join('\n\n'),
};

const CLAUDE_EVENTS = [
  {
    type: 'user',
    uuid: 'claude-turn-1',
    timestamp: '2026-07-29T11:00:00.000Z',
    sessionId: 'claude-conversation-7',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Analise src/auth.mjs.' },
        { type: 'tool_result', content: 'resultado interno' },
        { type: 'text', text: '<system-reminder>contexto injetado</system-reminder>' },
      ],
    },
  },
  'nao-json entre eventos validos',
  {
    type: 'assistant',
    uuid: 'claude-answer-1',
    timestamp: '2026-07-29T11:00:01.000Z',
    sessionId: 'claude-conversation-7',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_creation: { ephemeral_1h_input_tokens: 1 },
        output_tokens: 5,
      },
      content: [
        { type: 'thinking', thinking: 'não entra na conversa' },
        { type: 'text', text: 'A autenticação está isolada.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.mjs' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'claude-meta',
    timestamp: '2026-07-29T11:04:00.000Z',
    sessionId: 'claude-conversation-7',
    message: { role: 'user', content: 'Generate a concise UI title for this task.' },
  },
  {
    type: 'user',
    uuid: 'claude-turn-2',
    timestamp: '2026-07-29T11:05:00.000Z',
    sessionId: 'claude-conversation-7',
    message: { role: 'user', content: 'Quais recommended_plugins são opcionais?' },
  },
  {
    type: 'assistant',
    uuid: 'claude-answer-2',
    timestamp: '2026-07-29T11:05:01.000Z',
    sessionId: 'claude-conversation-7',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 7, output_tokens: 4 },
      content: [
        { type: 'text', text: 'Todos são opcionais.' },
        { type: 'tool_use', name: 'Write', input: { file_path: 'src/result.mjs' } },
      ],
    },
  },
];

const CLAUDE_CONTENT = `${jsonl(CLAUDE_EVENTS)}\n`;

const EXPECTED_CLAUDE = {
  provider: 'claude',
  sessionId: 'claude-conversation-7',
  model: 'claude-sonnet-5',
  latestTurnId: 'claude-turn-2',
  latestUserPrompt: 'Quais recommended_plugins são opcionais?',
  latestAssistantMessage: 'Todos são opcionais.',
  userPrompts: ['Analise src/auth.mjs.', 'Quais recommended_plugins são opcionais?'],
  assistantMessages: ['A autenticação está isolada.', 'Todos são opcionais.'],
  tools: ['Read', 'Write'],
  consultedFiles: ['src/auth.mjs', 'src/result.mjs'],
  changedFiles: ['src/result.mjs'],
  turns: [
    {
      turnId: 'claude-turn-1',
      timestamp: '2026-07-29T11:00:00.000Z',
      userPrompts: ['Analise src/auth.mjs.'],
      assistantMessages: ['A autenticação está isolada.'],
      tools: ['Read'],
      consultedFiles: ['src/auth.mjs'],
      changedFiles: [],
      conversation: [
        { role: 'Usuário', text: 'Analise src/auth.mjs.' },
        { role: 'Assistente', text: 'A autenticação está isolada.' },
      ],
      usage: {
        input: 10,
        cached: 3,
        cacheWrite: 2,
        cacheWrite1h: 1,
        output: 5,
        reasoning: 0,
        total: 20,
      },
      model: 'claude-opus-4-8',
    },
    {
      turnId: 'claude-turn-2',
      timestamp: '2026-07-29T11:05:00.000Z',
      userPrompts: ['Quais recommended_plugins são opcionais?'],
      assistantMessages: ['Todos são opcionais.'],
      tools: ['Write'],
      consultedFiles: ['src/result.mjs'],
      changedFiles: ['src/result.mjs'],
      conversation: [
        { role: 'Usuário', text: 'Quais recommended_plugins são opcionais?' },
        { role: 'Assistente', text: 'Todos são opcionais.' },
      ],
      usage: {
        input: 7,
        cached: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 4,
        reasoning: 0,
        total: 11,
      },
      model: 'claude-sonnet-5',
    },
  ],
  rawTextForDetection: [
    'Analise src/auth.mjs.',
    'Quais recommended_plugins são opcionais?',
    'A autenticação está isolada.',
    'Todos são opcionais.',
  ].join('\n\n'),
};

test('[req:MOD-21] parseCodexTranscriptContent preserva o formato completo sem filesystem', () => {
  assert.deepEqual(parseCodexTranscriptContent(CODEX_CONTENT, PARSE_OPTIONS), EXPECTED_CODEX);
});

test('[req:MOD-21] parseClaudeTranscriptContent preserva o formato completo sem filesystem', () => {
  assert.deepEqual(parseClaudeTranscriptContent(CLAUDE_CONTENT, PARSE_OPTIONS), EXPECTED_CLAUDE);
});

test('[req:MOD-21] parseTranscriptContent ignora JSONL inválido e despacha pelo primeiro evento reconhecível', () => {
  assert.deepEqual(parseTranscriptContent(`invalida\n${CODEX_CONTENT}`, PARSE_OPTIONS), EXPECTED_CODEX);
  assert.deepEqual(parseTranscriptContent(`invalida\n${CLAUDE_CONTENT}`, PARSE_OPTIONS), EXPECTED_CLAUDE);
});

test('[req:MOD-21] filtro de meta-prompt é ancorado e não engole menção humana a recommended_plugins', () => {
  const parsed = parseCodexTranscriptContent(CODEX_CONTENT, PARSE_OPTIONS);
  assert.doesNotMatch(parsed.rawTextForDetection, /catalogo injetado/);
  assert.ok(parsed.userPrompts.includes('Quais recommended_plugins devo instalar no projeto?'));
  assert.deepEqual(parsed.turns.map((turn) => turn.turnId), ['codex-turn-1', 'codex-turn-2']);
});

test('[req:MOD-21] roots explícitos normalizam paths do repositório e excluem paths do Vault', () => {
  const content = jsonl([
    { type: 'turn_context', payload: { turn_id: 'path-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        turn_id: 'path-turn',
        name: 'Read',
        arguments: JSON.stringify({
          source: 'C:\\work\\demo\\src\\feature.mjs',
          privateNote: 'C:\\work\\demo\\.WendKeep-vault\\02-Sessões\\private.md',
        }),
      },
    },
  ]);
  const parsed = parseCodexTranscriptContent(content, PARSE_OPTIONS);
  assert.deepEqual(parsed.consultedFiles, ['src/feature.mjs']);
  assert.deepEqual(parsed.changedFiles, []);
});

test('[req:MOD-21] resolveTurnIdentity usa id solicitado, latest e ordem observada sem inventar turno', () => {
  assert.deepEqual(resolveTurnIdentity(EXPECTED_CODEX, 'codex-turn-1'), {
    id: 'codex-turn-1', order: 1, observedAt: '2026-07-29T10:00:01.000Z',
  });
  assert.deepEqual(resolveTurnIdentity(EXPECTED_CODEX), {
    id: 'codex-turn-2', order: 2, observedAt: '2026-07-29T10:05:00.000Z',
  });
  assert.equal(resolveTurnIdentity(EXPECTED_CODEX, 'turno-ausente'), null);
  assert.equal(resolveTurnIdentity({ turns: [] }), null);
});

test('[req:IMPORT-7] completude Codex vem somente de task_complete do mesmo turn_id', () => {
  const content = jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-completo' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-completo' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-em-execucao' } },
  ]);
  assert.deepEqual([...completedCodexTurnIdsContent(content)], ['turn-completo']);
});

test('[req:MOD-20] [req:MOD-21] parsers por conteúdo são determinísticos e não mutam opções', () => {
  const before = JSON.stringify(PARSE_OPTIONS);
  const first = parseTranscriptContent(CLAUDE_CONTENT, PARSE_OPTIONS);
  const second = parseTranscriptContent(CLAUDE_CONTENT, PARSE_OPTIONS);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(PARSE_OPTIONS), before);
});

test('[req:IMPORT-6] metadados internos são removidos apenas das mensagens do assistente no transcript Codex', () => {
  const userMention = [
    'Também encontrei este texto em outra sessão:',
    '</session>',
    '<oai-mem-citation> <citation_entries>',
    '</citation_entries> <rollout_ids> exemplo </rollout_ids> </oai-mem-citation>',
  ].join('\n');
  const completeAssistant = [
    'A correção foi validada.',
    '</session>',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:1-2|note=[internal]',
    '</citation_entries>',
    '<rollout_ids>019f-example</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');
  const truncatedAssistant = [
    'O próximo passo está pronto.',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:3-4|note=[truncated]',
  ].join('\n');
  const inlineMarkerMention = 'Os nomes <oai-mem-citation>, <citation_entries> e <rollout_ids> permanecem como exemplo.';
  const adjacentInlineMention = 'A documentação usa <oai-mem-citation> <citation_entries> como exemplo.';
  const attachedInlineMention = 'Docs:<oai-mem-citation> <citation_entries> são tags.';
  const lineStartInlineMention = 'Marcadores:\n<oai-mem-citation> <citation_entries> são tags.';
  const content = jsonl([
    { type: 'turn_context', timestamp: '2026-08-01T13:00:00.000Z', payload: { turn_id: 'meta-1' } },
    { type: 'event_msg', payload: { type: 'user_message', turn_id: 'meta-1', message: userMention } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-1', message: completeAssistant } },
    { type: 'turn_context', timestamp: '2026-08-01T13:01:00.000Z', payload: { turn_id: 'meta-2' } },
    { type: 'event_msg', payload: { type: 'user_message', turn_id: 'meta-2', message: 'Continue.' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        turn_id: 'meta-2',
        content: [{ type: 'output_text', text: truncatedAssistant }],
      },
    },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Use </session> apenas como exemplo.' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Terceira resposta.\n<oai-mem-citation>' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Quarta resposta.\n<citation_entries>' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Quinta resposta.\n<citation_entries>\nMEMORY.md:5-6|note=[standalone]\n</citation_entries>' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Sexta resposta.\n<citation_entries>\nMEMORY.md:7-8|note=[standalone-truncated]' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Sétima resposta.\n<rollout_ids>019f-complete</rollout_ids>' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Oitava resposta.\n<rollout_ids>\n019f-truncated' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Nona resposta.\n<rollout_ids>' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima resposta.\n<citation_entries>x' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima primeira resposta.\n<rollout_ids>x' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima segunda resposta.\n</session><oai-mem-citation><citation_entries>x' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima terceira resposta.</session><oai-mem-citation><rollout_ids>x' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima quarta resposta.<oai-mem-citation> <citation_entries>x' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima quinta resposta.\n<citation_entries>\ntexto comum depois' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima sexta resposta.\n<rollout_ids>x</rollout_ids>\ntexto comum depois' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'Décima sétima resposta.\n<oai-mem-citation><citation_entries>x</citation_entries></oai-mem-citation>\ntexto comum depois' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: 'A tag <oai-mem-citation> citada sem payload permanece.' } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: inlineMarkerMention } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: adjacentInlineMention } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: attachedInlineMention } },
    { type: 'event_msg', payload: { type: 'agent_message', turn_id: 'meta-2', message: lineStartInlineMention } },
  ]);

  const parsed = parseCodexTranscriptContent(content, PARSE_OPTIONS);

  assert.ok(parsed.userPrompts.includes(userMention), 'a citação escrita pelo usuário deve permanecer intacta');
  assert.deepEqual(parsed.assistantMessages, [
    'A correção foi validada.',
    'O próximo passo está pronto.',
    'Use </session> apenas como exemplo.',
    'Terceira resposta.',
    'Quarta resposta.',
    'Quinta resposta.',
    'Sexta resposta.',
    'Sétima resposta.',
    'Oitava resposta.',
    'Nona resposta.',
    'Décima resposta.',
    'Décima primeira resposta.',
    'Décima segunda resposta.',
    'Décima terceira resposta.',
    'Décima quarta resposta.',
    'Décima quinta resposta.\ntexto comum depois',
    'Décima sexta resposta.\ntexto comum depois',
    'Décima sétima resposta.\ntexto comum depois',
    'A tag <oai-mem-citation> citada sem payload permanece.',
    inlineMarkerMention,
    adjacentInlineMention,
    attachedInlineMention,
    lineStartInlineMention,
  ]);
  const sanitizedMetadata = parsed.assistantMessages.filter((message) => (
    message !== inlineMarkerMention
      && message !== adjacentInlineMention
      && message !== attachedInlineMention
      && message !== lineStartInlineMention
      && message !== 'A tag <oai-mem-citation> citada sem payload permanece.'
  ));
  assert.doesNotMatch(sanitizedMetadata.join('\n'), /oai-mem-citation|citation_entries|rollout_ids/);
  assert.equal(parsed.latestAssistantMessage, lineStartInlineMention);
});

test('[req:IMPORT-6] metadados internos completos e truncados são removidos das mensagens Claude', () => {
  const completeAssistant = [
    'Resposta Claude preservada.',
    '<oai-mem-citation>',
    '<citation_entries></citation_entries>',
    '<rollout_ids>019f-example</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');
  const truncatedAssistant = 'Segunda resposta.\n<oai-mem-citation> <citation_entries>';
  const content = jsonl([
    {
      type: 'user',
      uuid: 'claude-meta-turn',
      timestamp: '2026-08-01T13:00:00.000Z',
      message: { role: 'user', content: 'Valide a captura.' },
    },
    {
      type: 'assistant',
      uuid: 'claude-meta-answer',
      timestamp: '2026-08-01T13:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: completeAssistant },
          { type: 'text', text: truncatedAssistant },
        ],
      },
    },
  ]);

  const parsed = parseClaudeTranscriptContent(content, PARSE_OPTIONS);

  assert.deepEqual(parsed.assistantMessages, ['Resposta Claude preservada.', 'Segunda resposta.']);
  assert.equal(parsed.latestAssistantMessage, 'Segunda resposta.');
  assert.doesNotMatch(parsed.rawTextForDetection, /oai-mem-citation|citation_entries|rollout_ids/);
});
