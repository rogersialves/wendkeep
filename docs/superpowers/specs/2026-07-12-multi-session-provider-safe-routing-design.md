# Roteamento seguro e múltiplas sessões ativas

## Objetivo

Permitir que Claude Code e Codex trabalhem simultaneamente em features diferentes no mesmo vault, sem sobrescrever o foco, a observabilidade ou os backlinks um do outro, e permitir a transferência explícita de uma change entre provedores.

## Autoridade e projeções

`.brain/SESSION_REGISTRY.json` será a autoridade por conversa canônica. Cada entrada contém `provider`, `status`, `session_file`, `transcript_paths`, `transcript_id`, `change_slug`, `last_seen` e, quando aplicável, linhagem. A mutação do registry será protegida por lock, releitura dentro do lock, escrita temporária e rename atômico.

`.brain/CURRENT_SESSION.md` deixa de ser fonte de roteamento. Ele será uma projeção humana gerada com todas as sessões ativas e um foco recente compatível com leitores antigos. Hooks nunca usarão esse foco como fallback para gravar dados vinculados a uma sessão.

`.brain/CURRENT_CHANGE.md` permanece como ponteiro global humano e visão de todas as changes abertas. O vínculo operacional fica em `SESSION_REGISTRY.json` por sessão; ele não representa propriedade e pode ser transferido entre Claude Code e Codex.

`CORE.md`, `COMPACTION_PROTOCOL.md`, `DIGEST.md` e `index.jsonl` continuam compartilhados. A compactação não troca a identidade: a conversa canônica é resolvida novamente e reconectada à mesma entrada.

## Resolução de identidade

Um resolvedor único retorna `resolved` ou `deferred` e nunca mistura provedores.

- Codex: `session_meta.payload.session_id` é a conversa canônica; `payload.id` é o rollout/transcript atual; `forked_from_id` e `parent_thread_id` são apenas linhagem.
- Claude Code: o caminho normalizado do transcript e o `sessionId` embutido identificam a conversa; IDs efêmeros de hook não substituem essa identidade.
- Compatibilidade: notas `codex` aceitam somente transcripts OpenAI; notas `claude` aceitam somente transcripts Anthropic.

Em `deferred`, o hook ainda injeta memória global, protocolo e backlog, mas não cria nota, não altera registry/CURRENT_SESSION e nenhum writer vinculado à sessão pode executar.

## Fluxo de changes

Ao criar uma change a partir de uma sessão resolvida, o WendKeep grava `change_slug` na entrada dessa conversa. O contexto injetado mostra a change vinculada e todas as demais pendências. `change bind <slug> --session <id>` transfere ou define o vínculo; `session list`, `session show` e `session use` permitem inspeção e foco humano sem criar ownership.

Encerrar uma sessão remove somente sua atividade e regenera o dashboard. Encerrar ou arquivar uma change não encerra outras sessões. O ponteiro global continua disponível como padrão para operações manuais, mas writers automáticos preferem obrigatoriamente o vínculo da sessão resolvida.

## Observabilidade e reconstrução

Stop, SubagentStop, importação, captura de decisões/planos/tarefas e rebuild recebem a identidade resolvida. Cada atualização registra origem do hook, provider, conversa canônica, transcript e timestamp. Entradas sem transcript ou incompatíveis aparecem como erro no rebuild; não podem ser filtradas silenciosamente nem produzir relatório verde.

## Compatibilidade e migração

Registries v1 serão lidos e promovidos idempotentemente. `transcript_path` legado vira o primeiro item de `transcript_paths`; campos escalares de foco permanecem em `CURRENT_SESSION.md` para leitores antigos. Valores vazios nunca substituem valores válidos no registry.

## Testes de aceitação

- Claude e Codex mantêm duas sessões e duas changes simultâneas sem clobber.
- Retomada/compactação do Codex conserva `session_id` apesar de trocar rollout.
- Claude reconecta pelo transcript e `sessionId` embutido.
- Transcript cross-provider resulta em `deferred` sem mutação dos quatro arquivos de memória.
- Duas mutações concorrentes preservam ambas as entradas do registry.
- Writers não recorrem a `CURRENT_SESSION.md` quando a identidade está ausente.
- Bind e transferência de change preservam a visibilidade global das pendências.
- Rebuild aponta entradas órfãs/incompatíveis e nunca omite custo silenciosamente.
- `npm test`, `npm run check` e E2E em vault temporário permanecem verdes.

## Fora de escopo

Não há ownership por agente, merge automático de conversas pai/filho, encerramento global de sessões, nem mudança no conteúdo semântico de `CORE.md` e `COMPACTION_PROTOCOL.md`.
