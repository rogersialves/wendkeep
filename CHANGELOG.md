# Changelog

All notable changes to **wendkeep** are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.46.1] — 2026-07-19

### Fixed

- **Turnos do Codex sumiam da nota sem nenhum aviso.** No Windows o Codex serializa o payload
  do `Stop` com o campo `last_assistant_message` cortado no meio, sem fechar a string JSON —
  bug upstream ainda aberto ([openai/codex#23784](https://github.com/openai/codex/issues/23784)).
  Sessão em português enche esse campo de acento, então o corte é frequente. O
  `readHookInput` fazia `JSON.parse` cru, lançava, e o `session-stop` saía com código 0
  escrevendo só no stderr — que o Codex descarta. Resultado: a nota era criada, o summary
  atualizava a cada prompt, e nenhuma iteração jamais entrava. Só o `Stop` quebrava porque
  `last_assistant_message` é o único campo exclusivo dele; `SessionStart` e
  `UserPromptSubmit` não o carregam.
  Como esse campo é o **último** do `StopCommandInput`, tudo que o wendkeep consome
  (`session_id`, `turn_id`, `transcript_path`, `cwd`) está no prefixo bem-formado. O
  `readHookInput` passa a recuperar esse prefixo numa passada só, descartando o campo
  truncado — nunca reconstruindo-o, porque metade de uma mensagem é dado inventado.
- **O hook parou de falhar em silêncio.** Todo caminho de bail do `session-stop` agora emite
  `systemMessage`, que a UI do Codex mostra, com o motivo e o comando de recuperação. O exit
  code continua 0 de propósito: hook de `Stop` que sai diferente de zero trava o turno
  (openai/codex#21921), e trocar turno perdido por sessão travada é pior negócio.
- **`resolveSessionIdentity` passa a usar o `SESSION_REGISTRY` como fonte do
  `transcript_path`** quando o payload não o traz. O registry já tinha o mapeamento; o lookup
  é que ficava abaixo do gate, inalcançável justo no caso que resolveria. A entrada precisa
  ser do mesmo provider, o que preserva o invariante do incidente de contaminação
  cross-provider de 2026-07-11.
- **`wendkeep import` deixou de ser cego para a sessão danificada.** O dedup perguntava
  "existe registro?", não "existe conteúdo?" — e como o `session-start` registra antes do
  `session-stop` escrever, **as sessões esvaziadas pelo bug acima eram exatamente as que o
  comando de recuperação se recusava a consertar.** Agora a decisão compara os turnos do
  transcript com os marcadores `wk-turn` já na nota: cobertura completa pula, parcial ou
  vazia completa a nota existente sem criar uma segunda. Sem flag opt-in — quem roda `import`
  depois de perder sessão não tem como saber que precisaria de uma. O relatório ganhou a
  categoria `repaired`, separada de `imported` (nota nova) e de `skipped` (já completa).
- **Sessões importadas ganhavam título de bloco injetado pelo harness.** Seis notas de um
  mesmo projeto ficaram chamadas `<recommended_plugins> Here is a list of plugins that ar`,
  no frontmatter e no nome do arquivo. Causa de uma linha: `buildIterationBlock` seleciona
  `userPrompts.at(-1)` e o `deriveSummary` usava `.find(Boolean)` — o harness injeta o bloco
  como **primeiro** prompt do turno e o pedido do usuário vem por **último**. Mesmo dado,
  ponta oposta. As duas seleções agora são a mesma, com `isBootstrapPrompt` (que passou a
  reconhecer `<recommended_plugins>`) como rede, aplicado ao prompt inteiro e não linha a
  linha — filtrar por linha cairia na linha seguinte do próprio bloco injetado.

### Recuperação

- Quem perdeu turnos de sessões Codex antes desta versão recupera com
  `wendkeep import --source codex`. O rollout do Codex fica íntegro em disco, e o import agora
  completa a nota existente em vez de pulá-la. Rodar mais de uma vez é no-op.
- Notas já criadas com título poluído **não** são renomeadas automaticamente: mexer em nome de
  arquivo quebra wikilink e reorganiza o grafo, e isso é decisão do dono do vault.

## [0.46.0] — 2026-07-18

### Added

- `wendkeep init` agora escreve também `<projeto>/.codex/hooks.json`, e não só
  `.claude/settings.json`. Fechava aqui o buraco mais confuso do onboarding com Codex: o
  `.mcp.json` gerado deixava o vault **alcançável**, então tudo parecia certo — mas sem hooks
  não havia sessão, `CURRENT_SESSION.md` nunca aparecia e o `registrySessions` ficava em 0. As
  saídas eram escrever o `.codex/hooks.json` à mão ou rodar `wendkeep import --source codex`
  depois do fato, ambas descobertas tarde demais. Um projeto novo com Codex nasce com sessão.
- Sete hooks wirados, marcados `codex: true` em `src/taxonomy.mjs`: `brain-inject`
  (SessionStart, matcher `startup|clear|compact`), `session-start` (SessionStart, `startup`),
  `session-ensure` e `change-context` (UserPromptSubmit, sem matcher), `session-stop` e
  `change-nag` (Stop, sem matcher) e `subagent-stop` (SubagentStop).
- Cinco hooks ficaram **deliberadamente de fora**, cada um com um comentário `// codex:` no
  `src/taxonomy.mjs` explicando o porquê — projetar um hook que não funciona é pior que não
  projetá-lo. `change-guard` lê `tool_input.command`, mas a superfície de shell do Codex é
  `exec` (`custom_tool_call`, com `tool_input` string crua) ou `exec_command`/`shell_command`:
  o guard falharia **aberto**, dando uma sensação de proteção que não existe. `change-warn` lê
  `tool_input.file_path`, e o `apply_patch` do Codex manda um envelope de patch sem esse campo.
  `plan-capture` não tem equivalente — `update_plan` é a lista de TODO corrente e dispara no
  meio do turno, não no fim do plano. `decision-capture` depende de `AskUserQuestion`, uma
  ferramenta exclusiva do Claude. E `task-log` depende de `TaskCompleted`, que não existe no
  enum de eventos de hook do Codex.
- A projeção Codex tem três diferenças em relação ao formato do `settings.json`, todas
  **silenciosas quando erradas** — daí valerem registro. (1) A chave de timeout é `timeoutSec`,
  não `timeout`. (2) O comando é sempre `npx wendkeep hook <nome>`, nunca a forma node-direta:
  aquela emite `${CLAUDE_PROJECT_DIR}`, que não existe no Codex, então a flag `preferLocal` é
  ignorada de propósito na projeção. (3) As chaves de evento são PascalCase — o snake_case que
  se vê em `[hooks.state]` no `~/.codex/config.toml` é o rótulo interno do evento, não a chave
  do JSON.
- Merge não-destrutivo, mesma disciplina do `mergeSettings`: reconhece um grupo já wirado e
  nunca duplica em re-`init`, preserva hooks de terceiros e hooks irmãos agrupados junto,
  `--force` atualiza `timeoutSec`/`statusMessage` no lugar, e um `.bak` é salvo. Arquivo
  existente ilegível não é tocado — a proposta vai para `.codex/hooks.json.new`.
- Testes: `tests/init-codex-hooks.test.mjs` (12 unitários sobre `mergeCodexHooks`) e um e2e em
  `tests/init-vault.test.mjs`. Suíte completa: 397 passando.

### Fixed

- Hooks Codex do wendkeep rodavam com o timeout **default de 600s**, não com o configurado. A
  chave correta é `timeoutSec`; `timeout` não é campo, não é rejeitado e simplesmente não é
  lido, então o valor caía no default sem um único aviso. Todo `.codex/hooks.json` escrito à
  mão antes disso (o do NutriGym, entre outros) carrega o erro. `mergeCodexHooks` migra a
  chave legada in place, **mesmo sem `--force`** — é correção de bug, não refresh opcional.
- `src/taxonomy.mjs` carregava um NUL (`0x00`) e um `0x1f` **literais** dentro da classe de
  caracteres do `deriveVaultDirName`. Por causa do NUL o `file` classificava o fonte como
  binário, e o ripgrep pula binário por default — um Grep por qualquer termo no arquivo
  voltava vazio, em silêncio. Não era erro, era ausência de resultado, e justo no arquivo onde
  vivem os specs de hook e as constantes de companion. Os dois bytes viraram as sequências de
  escape `\x00` e `\x1f`; o regex é byte-idêntico em comportamento (#7).

### Changed

- A numeração dos passos do `init` foi de `[n/4]` para `[n/5]`. O novo passo 3 é o
  `.codex/hooks.json`, então `.mcp.json` passou a ser `[4/5]` e as cores `[5/5]`.

### Migration

- **Quem já tem hooks Codex do wendkeep vai ver um prompt "Hooks need review" a mais neste
  upgrade.** Isso é esperado, não regressão: a identidade do hook é hasheada, e corrigir
  `timeout` → `timeoutSec` muda o conteúdo, logo muda o hash, logo o Codex pede re-aprovação.
  Uma vez só.
- Independente disso, todo hook nasce Untrusted: o Codex enumera mas **não executa** até o
  usuário aprovar no prompt de startup. O `init` não tem como pré-aprovar —
  `--dangerously-bypass-hook-trust` é por invocação e não persiste `trusted_hash` — então
  passou a imprimir um aviso explicando o prompt em vez de deixar o usuário achar que o wiring
  falhou.
- O `init` **não** escreve `[features] hooks = true` no `.codex/config.toml`, de propósito. O
  Codex declara essa feature como `Stage::Stable` com `default_enabled: true`, então a linha
  seria no-op — e a camada de config do projeto é trust-gated como um todo de qualquer forma.

## [0.45.1] — 2026-07-18

### Fixed

- Documentação: 31 inconsistências entre os READMEs e o comportamento real do pacote,
  encontradas auditando o texto contra o tarball publicado da 0.45.0. Nenhuma mudança de
  código — `src/`, `hooks/`, `bin/` e `schema/` são idênticos aos da 0.45.0. Este release
  existe porque o README viaja dentro do tarball: a correção só chega à página do npm e a
  quem instala o pacote com uma nova publicação.
- Duas afirmações levavam o usuário a um resultado diferente do prometido: o README dizia
  que `context-mode` vinha pré-marcado no picker de companions e que `init --yes` o
  instalava (todo companion é `default: false` desde a 0.24.0, e `--yes` instala zero), e
  as seções de requisitos/init sugeriam captura de sessões Codex automática após o `init`,
  contradizendo o próprio Notes & roadmap (o `init` só wira `.claude/settings.json`).
- Tabela de Comandos reescrita a partir do `--help` do binário: faltavam `stats` (usado na
  própria introdução do README), `dashboard`, `change use|continue|abandon|relink`,
  `cost --top|--trend|--write`, `import --stamp-ids|--rescan-decisions`, `verify --change`,
  `spec rebase --accept-current`, `sensors add --name|--description` e `sync-defs --reseed`.
  Três linhas da tabela em inglês tinham ficado em português.
- Correções factuais: `--force` dispensa só a checagem de tarefa aberta (G1), não o gate
  inteiro; `verdict.json` é exigido sempre desde a 0.31.0 (uma change sem `[req:]` destrava
  com o verdict trivial do `verify --deep`, não pulando a etapa); `change new` não scaffolda
  mais `specs/` e `--simple` pula o `design.md`; os sensores semeados são uma allow-list
  fixa mais `memory-validation`; `detectProvider()` não conhece Copilot; `context-mode` é
  plugin do Claude Code, sem entrada em `.mcp.json`; `brain-inject` roda em
  `startup|clear|compact`; as skills vão para `.claude/skills` e `.agents/skills`;
  `dotcontext` é `hidden`; `docs/` não vai no tarball; e uma tarefa carrega um só
  `[sensor:]` (`[req:]` é que aceita vários).
- `README.pt-BR.md`: a tabela de comandos estava partida ao meio por um parágrafo, fazendo
  oito linhas renderizarem como texto cru no npm e no GitHub. Reparada e sincronizada com o
  inglês — os dois arquivos fecham com os mesmos 20 comandos e 42 flags.

## [0.45.0] — 2026-07-18

### Fixed

- Observabilidade: o note de sessão deixa de ser reescrito com timestamp novo a cada Stop
  quando o uso não muda. A preservação de `atualizado_em` (`token-usage.mjs`) comparava
  `previous` (parseado do note) com `current` (recém-computado) via `JSON.stringify` —
  sensível à ordem das chaves, que difere entre parse e build, então a comparação **sempre**
  falhava e o timestamp era re-stampado toda vez. Novo `sameUsageData(a, b)` compara os campos
  de uso de forma ordem-insensível (ignorando `atualizado_em`). Corrige o churn de reescrita e
  o teste flaky "same sources produce byte-identical markdown".

## [0.44.0] — 2026-07-17

### Changed

- `wendkeep change new` não cria mais o placeholder `specs/exemplo/spec.md` (nem a pasta
  `specs/`). Era ruído — sempre deletado à mão, e `discoverSpecDeltas` já o filtrava. Quando
  a change resolve `spec_impact: required`, o autor escreve `specs/<capability>/spec.md`
  direto; o formato do delta vive na skill wk-workflow. O filtro de `exemplo` fica (compat
  com changes antigas em voo).
- README gerado do `07-Specs` reescrito para explicar o ponto mais confundido: specs são
  **por capability, não por mudança** (N changes promovem no mesmo arquivo; o histórico
  por-change vive em `_arquivo`). `promoteSpecs` passa a garantir/atualizar esse README a
  cada archive (`ensureSpecsReadme`), então vaults existentes recebem o texto novo no
  próximo archive — não só os criados via `init`.

## [0.43.0] — 2026-07-17

### Fixed

- Dedup de nota derivada era assimétrico: aprendizado deduplicava recursivamente (vault
  inteiro), mas **bug e decisão só olhavam a pasta do mês** (`existingKeysForSession`, scan
  não-recursivo). Uma nota da sessão numa subpasta `DIA` legada não era vista, então um
  re-import/re-captura da mesma sessão criava uma duplicata de bug/decisão. Agora
  `existingKeysForSession` varre a pasta derivada recursivamente (como o de aprendizado),
  mantendo a semântica per-sessão (só notas que referenciam a sessão contam).

## [0.42.0] — 2026-07-17

### Changed

- `wendkeep renumber-decisions --apply` agora **move** as notas de subpastas `DIA N` para a
  pasta do mês da sua data (achatando o legado), consistente com `renumber-bugs`/
  `renumber-learnings` do 0.41.0. Antes só renomeava in-place para `ADR-NNNN-<slug>` e
  deixava as pastas de dia intactas. Os wikilinks já eram reescritos vault-wide; agora
  acompanham o novo caminho de mês, e as pastas `DIA` que ficam vazias são removidas.
  Notas sem data resolvível preservam a pasta atual (nunca são perdidas). Idempotente.

## [0.41.0] — 2026-07-16

### Added

- Notas derivadas numeradas: bug e aprendizado gerados automaticamente nascem como
  `BUG-NNNN-<slug>.md` / `APR-NNNN-<slug>.md` na pasta do mês (nunca subpasta `DIA N`),
  com frontmatter `bug:`/`apr:` e H1 `# BUG-0001 — <título>` — paridade com o ADR de
  04-Decisões. Numeração via `getNextDerivedNumber` (scan recursivo, max+1; `getNextAdrNumber`
  virou wrapper).
- `wendkeep note new --type bug|learning "<título>"`: cria a nota manual já numerada no
  path certo (respeitando locale), com backlink da sessão ativa, e imprime o path — o
  agente nunca calcula número nem pasta à mão. `--date YYYY-MM-DD` opcional.
- `wendkeep renumber-bugs` e `wendkeep renumber-learnings`: migração retroativa — preview
  por default, `--apply` renomeia em ordem cronológica, MOVE notas de subpastas `DIA N` e
  da raiz para a pasta do mês, normaliza frontmatter/H1, reescreve wikilinks vault-wide
  (full-path e basename) e remove pastas `DIA` vazias. Idempotente.
- Convenção injetada (VAULT_COMPLEMENT_RULES) e seeds wk-debugging (pt/en) ensinam a
  numeração, a regra sem-DIA e o uso de `wendkeep note new`.

### Fixed

- `findLinkedDerivedNotes` (Stop hook) agora varre as pastas derivadas recursivamente —
  antes só enxergava notas na raiz de 04-Decisões/05-Bugs/06-Aprendizados, então notas nas
  subpastas de mês nunca entravam no merge de wikilinks da sessão.

### Migration

- Para migrar vaults existentes: `wendkeep renumber-bugs` (revisar preview) →
  `wendkeep renumber-bugs --apply`; idem `renumber-learnings`. Depois
  `wendkeep sync-defs --project . --reseed` para atualizar as skills wk-*.

## [0.40.0] — 2026-07-16

### Added

- `parseTasks` captura **todos** os `[req:]` de uma tarefa em `reqs: string[]` (`req` permanece
  como alias do primeiro, retrocompatível). Antes, só o primeiro entrava no pacote de
  verificação e os demais sumiam sem aviso.
- Heading de requisito aceita ID puro (`### Requisito: GATE-1`) como identidade, além do
  formato preferido `### Requisito: <ID> — <nome>`. Diagnóstico de requisito órfão agora
  ensina o formato esperado com exemplo concreto.
- `findProjectRoot`: `wendkeep verify` executado de um subdiretório sobe a árvore até achar
  `wendkeep.sensors.json`/`.wendkeep.json` (à la `.git`); `--project` continua autoritativo.
- `--help`/`-h` universal: qualquer subcomando com `--help` imprime a ajuda e sai com 0,
  interceptado antes da resolução de vault — nunca executa o comando.

### Fixed

- Regex de ID de requisito unificada entre tarefa e spec (`REQ_ID_RE_SRC`): IDs
  multi-segmento (`API-AUTH-2`) agora são reconhecidos também nas tarefas.
- `wendkeep verify` distingue `wendkeep.sensors.json` ausente (aviso com path + dica
  `--project`) de JSON inválido (erro alto com a mensagem do parse). Antes, ambos viravam
  "sensor não definido" para todos os sensores.
- `wendkeep import` com flag desconhecida agora falha com exit 2 citando a flag, em vez de
  cair no default destrutivo `--source all` (que chegou a importar 78 sessões sem querer).
- Templates seed (skills de workflow pt/en) documentam o formato de heading de requisito e o
  suporte a múltiplos `[req:]` por tarefa.

## [0.39.0] — 2026-07-13

### Added

- Configuração provider-neutral `.wendkeep.json`, descoberta do diretório da sessão para os
  pais, permitindo que Codex e Claude Code resolvam o mesmo vault sem variável global do
  Windows. Caminhos relativos ao projeto e caminhos absolutos são suportados.
- Identidade estável `projectId`, espelhada em `.brain/PROJECT.json`; vínculos que apontem
  para o vault de outro projeto são rejeitados antes de qualquer gravação.
- `doctor` informa caminho e origem do vínculo efetivo. Comandos CLI executados dentro do
  projeto também descobrem o vault local, mantendo `--vault` como override explícito.

### Changed

- `wendkeep init` cria o vínculo projeto→vault de forma idempotente e adota instalações
  antigas registradas em `.claude/settings.json`, sem mover ou dividir o histórico.
- Um vínculo local sempre vence um `OBSIDIAN_VAULT_PATH` herdado pelo processo. A variável
  permanece apenas para compatibilidade de comandos manuais legados.

### Fixed

- Hooks do Codex deixam de gravar sessões no vault doméstico `~/wendkeep-vault` quando o
  processo não recebe o ambiente privado do Claude Code. Sem vínculo local ou payload
  explícito, o hook agora falha de modo seguro, emite diagnóstico e não cria arquivos.
- Projetos simultâneos deixam de compartilhar acidentalmente sessões, mudanças e grafo por
  causa de uma variável global de usuário apontando para um único vault.

### Migration

- Após atualizar, execute uma vez `wendkeep init --project . --vault <vault> --yes`, depois
  `wendkeep sync-defs --project . --reseed` e `wendkeep doctor --project .`; reinicie Codex e
  Claude Code para recarregar os artefatos gerados.

## [0.38.3] — 2026-07-12

### Fixed

- Sessões do Codex Desktop voltam a ser criadas quando `SessionStart` ou o primeiro `UserPromptSubmit` não fornecem `transcript_path`: o resolvedor usa o UUID canônico de `CODEX_THREAD_ID` e associa o rollout à mesma entrada assim que o transcript materializa.
- A barreira cross-provider permanece fail-closed: quando `CODEX_THREAD_ID` e `session_meta.payload.session_id` estão presentes, divergência entre eles adia a escrita em vez de contaminar outra sessão.

## [0.38.2] — 2026-07-12

### Fixed

- Observabilidade de sessão: o `Effort` do Claude Code passa a derivar da **presença** de blocos `thinking` (a `signature` persiste mesmo quando o Claude Code redige o texto do pensamento), não da estimativa por caracteres — que dava `0` e marcava a sessão como `unknown` mesmo com o extended thinking ativo (visto em 42/43 chamadas do transcript principal). Rótulo binário `thinking`/`none`, desacoplado da contagem de reasoning tokens. Subagents com mesmo modelo/estado deixam de se dividir em linhas `unknown` + `thinking ~Nk` e agrupam corretamente. Reasoning do Claude vira estimativa-piso do texto sobrevivente (não determina mais o effort). Caminho Codex inalterado.

## [0.38.1] — 2026-07-12

### Fixed

- Sessão Claude nova não perde mais o 1º turno: `resolveSessionIdentity` usa o `session_id` do hook como identidade canônica quando o transcript ainda não materializou em disco, em vez de adiar a criação da nota. Codex mantém a exigência de rollout/registry — a barreira anti-contaminação do 0.38.0 segue intacta.
- `task-log` e `subagent-stop` passam a honrar `input.provider` ao resolver a sessão (paridade com `decision-capture`), evitando deferimento falso quando o provider do ambiente diverge do transcript.

## [0.38.0] — 2026-07-12

### Added

- Registry multi-sessão v2: `SESSION_REGISTRY.json` passa a ser a autoridade por conversa, enquanto `CURRENT_SESSION.md` vira um dashboard compatível com todas as sessões ativas.
- `wendkeep session list|show|use` e `wendkeep change bind <slug> --session <id>` permitem inspecionar sessões concorrentes e transferir explicitamente o vínculo de uma change.
- Metadados de auditoria da observabilidade registram caller, conversa canônica, transcript e instante da atualização.

### Fixed

- Roteamento cross-provider agora é fail-closed: Codex usa `session_meta.payload.session_id`, Claude usa o `sessionId` do transcript, e writers não recorrem ao foco global quando a identidade é ambígua.
- Atualizações concorrentes do registry usam lock, releitura e rename atômico; patches vazios não apagam transcript ou metadados válidos.
- `cost rebuild` reporta entradas órfãs, ausentes ou incompatíveis como estado não verde em vez de omiti-las silenciosamente.

## [0.37.0] — 2026-07-11

### Added

- Observabilidade consolidada em `## Agentes, tokens e custos`: Stop, SubagentStop, importação e rebuild usam um único writer atômico para main + subagents.
- Ledger por modelo/origem com reasoning tokens e effort, sem alterar a regra de preço do modelo.
- Novo `wendkeep cost rebuild`, dry-run por padrão; `--apply` reconstrói sessões antigas via `SESSION_REGISTRY` e grava `.brain/COST_REBUILD.json`.
- Preços API-equivalentes de GPT-5.6 Sol, Terra e Luna.

### Fixed

- Custos de subagents são atribuídos ao modelo que realmente os executou, em vez do modelo principal.
- Migração remove os headings legados sem perder reaberturas ou iterações mal posicionadas.
- Totais combinados de tokens/custo são atualizados também no `SubagentStop` e persistidos em campos compatíveis com os dashboards existentes.

## [0.36.0] — 2026-07-11

_Publicada no npm sem changelog dedicado (bump de versão não foi commitado à época);
registrada retroativamente para paridade npm ↔ GitHub. As mudanças reais desta faixa
estão consolidadas entre 0.35.0 e 0.38.1._

## [0.35.0] — 2026-07-11

### Fixed

- **Wikilinks para changes arquivadas não quebram mais.** `archive` e `abandon` movem a pasta
  para `_arquivo/<data>-<slug>/` — e todo wikilink gravado ANTES do move (sessões fechadas,
  decisões, outras changes) morria, aparecendo cinza no grafo (visto em produção). Agora o move
  **reescreve os wikilinks no vault inteiro** (`[[08-Mudanças/<slug>/…]]` →
  `[[08-Mudanças/_arquivo/<data>-<slug>/…]]`, full-path com e sem alias; nunca por basename —
  `proposta`/`design` existem em toda change). Fail-quiet: a reescrita nunca derruba o archive.

### Added

- **`wendkeep change relink [--apply] [--json]`** — cura retroativa para vaults com links já
  mortos (changes arquivadas antes da 0.35.0): mapeia cada slug morto para o dir datado em
  `_arquivo/` e reescreve. Dry-run por default; slug ambíguo (arquivado 2×) é reportado e pulado
  — nunca chuta; sem archive correspondente vira aviso.

## [0.34.1] — 2026-07-11

### Fixed

- **Tabela "Por subagent" ilegível na nota de sessão**: a tabela markdown vivia dentro de
  `<details>` e o Obsidian (reading view) trata o bloco como HTML cru — sem renderizar a
  tabela, tudo virava uma linha só de pipes embaralhados (visto em produção). A seção agora usa
  um sub-heading `### Por subagent (N)` + tabela markdown pura: renderiza correto e continua
  colapsável via fold nativo de heading. Notas existentes se autocuram no próximo Stop/refresh
  (a seção inteira é regenerada pelo upsert).

## [0.34.0] — 2026-07-11

### Added

- **Spec efetiva por change**: `wendkeep spec effective --change <slug> [--json]` combina o
  contrato consolidado com somente o delta selecionado, incluindo origem e operação por requisito.
- `change use <slug>` troca o ponteiro global; `change continue <arquivada> <novo-slug>` cria
  continuação com backlink sem reabrir arquivo nem herdar evidência/verdict.
- `sync-defs --check`, metadata de versão/hash e entrega idêntica de skills em `.claude/skills`
  e `.agents/skills`.
- `SPECS_STATE.json`, baseline por change e `spec migrate/rebase` para detectar edição direta e
  conflitos concorrentes no mesmo requisito.

### Changed

- `08-Mudanças/<slug>/specs/` é o único local de autoria. `07-Specs` permanece como contrato
  consolidado gerado/read-only, preservando ADRs e links históricos.
- `verify --deep` agora grava requisitos completos em `verificacao.json` e sela o pacote com
  `effectiveSpecHash`; `wk-verify` não relê `07-Specs`.
- `doctor` valida todas as changes abertas e avisa quando skills precisam de reseed + reinício.

### Fixed

- Requisitos `ADDED` ainda não arquivados deixam de ficar invisíveis ao verificador independente.
- Archives concorrentes bloqueiam somente quando outra change alterou o mesmo requisito; mudanças
  não relacionadas na mesma capability podem prosseguir.

### Migration

- Rode `wendkeep spec migrate --vault <vault>` uma vez para adotar os contratos consolidados atuais.
- Rode `wendkeep sync-defs --reseed --vault <vault> --project .` e reinicie Claude Code/Codex.

## [0.33.0] — 2026-07-11

### Added

- **Visão global de changes abertas**: `SessionStart`, `UserPromptSubmit`, `wendkeep change list`
  e `wendkeep change status` sem slug mostram todas as pendências, inclusive as iniciadas por
  outro agente.
- Ações de takeover explícitas no contexto: Claude, Codex ou outro agente podem retomar uma
  change existente sem perder o restante do backlog.

### Changed

- `.brain/CURRENT_CHANGE.md` continua como ponteiro global único, agora marcado como change
  **atual**. Comandos implícitos (`done`, `verify`, `archive`, `abandon`) continuam restritos a ela.
- Mudanças em qualquer `tarefas.md` invalidam o hash do hook de contexto e reinjetam a lista global
  na sessão afetada.
- `change-nag` permanece local à change atual; pendências de outra frente não bloqueiam o agente
  em foco.

## [0.32.0] — 2026-07-09

### Added

- **Contrato explícito `spec_impact`** para changes novas: `pending`, `required` ou `none`.
  Changes materiais (`required`) precisam listar a capability e manter um delta real em
  `specs/<capability>/spec.md`; `none` exige justificativa em `spec_impact_reason`.
- **Snapshots imutáveis de planos aprovados** em `planos/<sha256-12>.md`, deduplicados por
  conteúdo. `plano-aprovado.md` passa a ser o índice dos snapshots, sem sobrescrever planos
  anteriores da mesma change.
- Diagnósticos de `spec_impact` no `wendkeep doctor`, incluindo estado pendente, delta ausente e
  divergência entre `specs:` e o conteúdo real no disco.

### Changed

- Hooks Claude de alta frequência usam `node` com caminho ancorado em
  `${CLAUDE_PROJECT_DIR}`. O `init` migra automaticamente os comandos relativos de 0.31.0 sem
  duplicar grupos, inclusive quando o agente muda o `cwd` para um subprojeto.
- `wk-workflow`, `wk-brainstorming`, `wk-planning` e o roteador de SessionStart agora exigem a
  classificação do impacto, o delta da capability e a rastreabilidade `[req:ID]` antes do archive.
- O archive passa a ser **fail-closed** para specs: placeholder, arquivo ausente ou falha de
  promoção bloqueiam o move e a criação do ADR.
- Ao arquivar, links da sessão para a change ativa são reescritos para o caminho em `_arquivo`.
  Decisões capturadas também entram imediatamente na seção de decisões da sessão ativa.

### Fixed

- **Planos aprovados descartados no Claude Code atual**: `plan-capture` agora lê
  `tool_response.plan` no payload estruturado de `PostToolUse:ExitPlanMode`, mantendo os formatos
  textuais legados e rejeições como no-op.
- **52 falhas `MODULE_NOT_FOUND` observadas em produção** quando `change-warn`/`change-guard`
  rodavam a partir de `mobile-app` ou `backend-core`.
- A criação automática de change por plano aprovado agora preserva o backlink da sessão resolvido
  pelo `transcript_path`/registry.
- `vault-health` não exige `## Encerramento` de uma sessão ainda ativa; continua validando a ordem
  completa quando a sessão está finalizada.

### Migration

- Rode `wendkeep init --force` para migrar hooks relativos instalados pela 0.31.0.
- Rode `wendkeep sync-defs --reseed` para atualizar as skills wk-* em vaults existentes.
- Changes antigas sem `spec_impact` continuam legíveis e são diagnosticadas como legadas; antes do
  próximo archive, classifique-as explicitamente como `required` ou `none`.

## [0.31.0] — 2026-07-09

### Added — enforcement do loop a2 (o loop deixa de ser opcional na prática)

- **5 hooks de lifecycle novos**, wired por default pelo `wendkeep init` (invocação **node-direta**
  `node node_modules/wendkeep/hooks/<name>.mjs` quando o pacote está instalado no projeto —
  ~100-250ms vs segundos do npx no Windows; fallback npx):
  - **`change-context`** (UserPromptSubmit) — re-injeta a change ativa (`<active_change_ping>`:
    slug + tarefas abertas) SÓ quando o estado mudou desde a última injeção (hash em sentinela por
    sessão). Sem change ativa: prompt com cara de tarefa ganha `<wk_skill_gate>` mandando invocar
    a Skill wk-workflow ANTES de editar — 1x por sessão.
  - **`change-warn`** (PostToolUse `Edit|Write|MultiEdit`) — edição de código sem change ativa
    gera aviso 1x/sessão (nunca bloqueia; ignora vault/.claude/.agent/.brain e não-código).
  - **`change-guard`** (PreToolUse `Bash`) — `wendkeep change archive --force` vindo do agente é
    **negado** (deny; escape: `WENDKEEP_ALLOW_FORCE=1` no ambiente); `git commit` com change ativa
    E (`--no-verify` OU sensor crítico vermelho) vira **ask** (o usuário decide). Fast-path sem
    I/O para comandos comuns.
  - **`change-nag`** (Stop) — change ativa com tarefas abertas bloqueia o encerramento 1x/sessão
    cobrando fechamento honesto (done / verify / **ou informar a pendência ao usuário**).
    Anti-loop absoluto via `stop_hook_active`.
  - **`plan-capture`** (PostToolUse `ExitPlanMode`) — **a ponte determinística plan-mode → vault**:
    plano aprovado no plan mode do Claude Code vira change no vault (proposta do Contexto, design
    do corpo, tarefas dos checkboxes) ou anexa `plano-aprovado.md` à change ativa. Não depende de
    a LLM lembrar do processo.
- **`wendkeep change abandon [slug]`** — a saída legítima para change que não vai adiante: move
  para `_arquivo/<data>-<slug>-abandonada` com `status: abandoned`, SEM ADR, SEM promoção de
  specs; limpa o ponteiro só se era a ativa. Elimina o motivo real de `--force` em scaffold.
- **`quickGateState(vaultBase)`** + sentinelas por sessão (`.brain/.change-*-<sid>`, GC >7 dias no
  Stop) em change-core — fonte única do estado do gate para hooks e CLI.
- **`wendkeep sync-defs --reseed`** — re-semeia as skills wk-* de `.brain/skills` com os seeds da
  versão instalada (é como um vault existente recebe as descriptions/HARD-GATE novos).

### Changed — gate endurecido + ativação da skill

- **Verdict SEMPRE exigido no archive** (breaking-ish): sem `verdict.json` o archive bloqueia,
  mesmo sem `[req:]` — `wendkeep verify --deep` grava o verdict trivial automático (1 comando).
  Changes em andamento criadas antes de 0.31.0 precisam de um `verify --deep` antes do archive.
- **G0 inescapável**: `--force` deixa de pular o check de scaffold — um scaffold cru NUNCA é
  arquivável (era o buraco que mintou ADR falso em produção).
- **`--force` e trivialidade rastreáveis**: ADR ganha `forced: true` (+ aviso ⚠️ no corpo) quando
  `--force` pulou tarefa aberta, e `trivial: true` quando a change não declarou `[req:]`/`[sensor:]`.
- **Promoção de specs = união frontmatter + disco**: o archive promove também os deltas REAIS
  achados em `specs/*/spec.md` mesmo com `specs: []` na proposta (warning por cap não listada;
  o `exemplo` placeholder do scaffold é filtrado). Fecha o buraco que deixava 07-Specs vazio com
  delta preenchido no disco.
- **Ativação da skill (paridade Superpowers)**: descriptions das wk-* reescritas com gatilhos
  concretos ("Use SEMPRE que o usuário pedir para implementar/criar/corrigir/refatorar…
  Invoque ANTES de editar qualquer arquivo"); `<HARD-GATE>` no corpo da wk-workflow; o
  `<wk_process>` do brain-inject agora manda **invocar a Skill** (verbo de skill) e cita `abandon`.

### Fixed

- **Seções apagadas pelo Stop (classe de bug, visto em produção)**: qualquer seção inserida entre
  `## Pendências` e `## Encerramento` era descartada pelo finalize (`replacePendingSection`
  reconstruía o span inteiro) — atingia `## Subagents & Workflows` (frontmatter sobrevivia, corpo
  sumia), `## Progresso do plano` e `## Mudanças`. Duas camadas: `upsertSection` agora ancora
  ANTES de `## Pendências`, e o finalize preserva seções desconhecidas dentro do span. Notas
  antigas se autocuram no próximo Stop/backfill (os dados persistem em `subagents/`).

### Known limitation (aceita e documentada)

- Hooks do mesmo evento rodam em **paralelo** no Claude Code: quando o `change-nag` bloqueia o
  Stop, o `session-stop` já finalizou a nota — o turno de continuação não é logado nela
  (recuperável via `session-backfill`/`import`; perda máx. de 1 turno, 1x por sessão).

## [0.30.0] — 2026-07-09

### Changed
- **Decision notes follow the ADR convention: `ADR-<NNNN>-<slug>`.** Every decision note now carries
  a 4-digit, zero-padded sequential number assigned in the order decisions are made (`ADR-0001`,
  `ADR-0002`, …) — replacing the old `YYYY-MM-DD-escolha-<slug>` filenames from the interactive and
  prose captures. The number goes in the filename, in an `adr:` frontmatter field, and as an
  `# ADR-NNNN — <title>` H1 prefix. The native `wendkeep change archive` ADR and the
  `createLinkedNotes` heuristic ADR widen from 3 to 4 digits (`ADR-007` → `ADR-0007`) to match.
- **Decision capture dedups by `content_key`, not by filename.** Because the filename now carries a
  fresh ADR number it can't dedup, so a decision already recorded in the target folder (same
  normalized question) is skipped by content — both the AskUserQuestion hook (`captureDecision`) and
  the agnostic prose capture (`captureProseDecisions`). New `decisionKeyExists` / `padAdr` helpers.

### Added
- **`wendkeep renumber-decisions`** — retroactive fix for vaults that accumulated the three historical
  naming eras (`ADR-NNN`, dated `escolha`, hand-written). Renumbers **every** note in 04-Decisões to
  `ADR-<NNNN>-<slug>` in strict chronological order, renames the files in place, and **rewrites every
  wikilink to them across the whole vault** (full-path, basename, and `|ADR-006` display aliases).
  Normalizes each note's `type: decision` / `adr:` / H1. Preview by default (writes nothing); pass
  `--apply` to commit the renames. Idempotent — a second run on a canonical vault is a no-op.
  `--vault P` / `--json`. New `hooks/renumber-decisions.mjs` (`planRenumber`, `renumberDecisions`,
  `slugFromDecisionName`, `decisionSortKey`, `normalizeDecisionContent`, `rewriteLinks`).

## [0.29.2] — 2026-07-09

### Fixed
- **Iteration turn marker renamed `codex-turn` → `wk-turn`** (provider-neutral). A **Claude**
  session's iterations carried `<!-- codex-turn: … -->` — a legacy name from when this was a
  Codex-only tool, confusing in the note source. The marker is a dedup key, so the change is
  backward-compatible: `hasTurnMarker` still recognizes the legacy name, and `insertIteration`
  **self-migrates** any `codex-turn` → `wk-turn` on the next write (backfill re-processes older
  notes). Shared helpers `turnMarker` / `hasTurnMarker` / `normalizeTurnMarkers` in obsidian-common;
  `vault-health` recognizes both.
- Note-visible fallback text "Checkpoint registrado pelo hook Stop do **Codex**" → provider-neutral.
- Stderr log prefix `[codex-obsidian]` → `[wendkeep]` across the hooks.

## [0.29.1] — 2026-07-09

### Added
- **`wendkeep import --rescan-decisions`** — re-scan **already-imported/captured** transcripts for
  prose decisions only (no session re-import). For sessions imported before 0.29.0 whose rollouts
  carry options-in-prose choices that were never captured. Walks the registry
  (`session_file` + `transcript_path`), runs the same conservative extraction, dedupes by filename
  — re-running is a no-op. `--limit N` / `--json` supported. New `rescanDecisions()` export.

## [0.29.0] — 2026-07-09

Codex decision parity — agnostic prose-decision capture.

### Added
- **Prose-decision capture** (`extractProseDecisions` / `captureProseDecisions` in
  `hooks/decision-capture.mjs`, wired inside `createLinkedNotes`): Codex has no
  `AskUserQuestion`-style tool — the agent asks in **prose**. A conservative pattern (assistant
  message with ≥2 enumerated options ending in a question + a SHORT user reply) now produces the
  **same decision note** the Claude hook writes (options + the user's choice, in `04-Decisões/`,
  wikilinked to the session). One integration point covers **live Stop, `import` and backfill,
  for every provider**. Validated on 144 real Codex rollouts: 6 genuine decisions extracted, no
  visible false positives.

### Notes (investigated, decided against)
- **Codex subagent telemetry**: real rollouts contain **no** subagent/parallel structure — nothing
  to map; documented as not applicable.
- **Codex structured events** (`thread_goal_updated`, `task_complete`): goal payload ≈ the initial
  prompt; task events are turn markers already parsed. No extra capture worth the noise.

## [0.28.1] — 2026-07-09

Startup-contention fixes — root-caused from a real VSCode startup log where the memory injection
silently dropped and MCPs timed out.

### Fixed
- **`brain-inject` timeout 15 → 45s.** The hook is healthy (~2.5s direct, ~4s via npx warm), but
  Windows session startup runs several `npx` cold-starts at once (a sibling MCP took **26s** in the
  log) and 15s silently killed the CORE+DIGEST injection for the whole session.
- **context-mode double-registration eliminated.** Its plugin ships its **own** MCP server; wiring
  an `.mcp.json` entry too registered it twice — two concurrent `npx context-mode` cold-starts,
  both timing out. The companion is now **plugin-only** (on non-Claude agents add the MCP manually:
  `npx -y context-mode`).
- **`MCP_TIMEOUT=60000` default** added to the settings `env` by init (only when absent — a user
  value is never clobbered), giving npx-launched stdio MCPs (wendkeep-vault included) headroom over
  Claude Code's 30s default.

### Upgrade
- Existing installs: re-run `wendkeep init` (now recognizes your vault) to pick up the timeout +
  `MCP_TIMEOUT`; remove a duplicated `context-mode` entry from `.mcp.json`/`enabledMcpjsonServers`
  by hand if present.

## [0.28.0] — 2026-07-09

Three new hooks: decisions, subagents, plan progress.

### Added
- **Decision capture** (`PostToolUse` / `AskUserQuestion` → `hooks/decision-capture.mjs`): when the
  agent asks the user to choose between options, the decision is recorded in `04-Decisões/` — the
  question, **every** option (label + description), the user's choice (✅), and a wikilink to the
  session. Explicit, high-signal decisions get full traceability in the graph. Shape validated
  against real transcripts.
- **Live subagent telemetry** (`SubagentStop` → `hooks/subagent-stop.mjs`): refreshes the session's
  subagent/workflow cost notes the moment each subagent finishes (reuses `upsertSubagentUsage`), so
  a session that never reaches `Stop` still has its telemetry. *Model choice stays the harness's
  job — wendkeep observes, it does not impose a routing rule.*
- **Plan progress log** (`TaskCompleted` → `hooks/task-log.mjs`): when a task is marked complete,
  appends it to a durable `## Progresso do plano` section in the active session note (before
  `## Encerramento`, so reopen can't strip it). A progress trail, not a fuzzy map to `tarefas.md`.

All three are wired by `wendkeep init`, are fail-open, and localize (pt-BR / en). `--force`-free —
they only read + append.

## [0.27.0] — 2026-07-08

### Fixed
- **Re-running `wendkeep init` no longer re-asks for the vault (or language) — and can't split your
  data.** On a project already set up, init now reads the registered vault from
  `.claude/settings.json` (`OBSIDIAN_VAULT_PATH`) and the locked locale from the vault's
  `.brain/config.json`, reuses both, and skips the prompts. Previously a re-run (e.g. after
  `npm i -D wendkeep@latest`) offered the *derived* default (`.<project>-vault`); accepting it — or
  mistyping the name — created a **second, divergent vault**. `--vault` / `--locale` still override.
  New exported `detectRegisteredVault()` / `readVaultLocale()`. `src/init.mjs`.

### Note
- You do **not** need `wendkeep init` for a routine update: the hooks live in the package
  (`settings.json` calls `npx wendkeep hook …`), so `npm i -D wendkeep@latest` updates them.
  Re-run `init` only when a release adds new wiring (the CHANGELOG says so); it's idempotent.

## [0.26.0] — 2026-07-08

### Fixed
- **`wendkeep init` output now follows the chosen vault language.** Picking Português left the
  whole summary + `[n/4]` steps + "Next steps" block in English; only the interactive prompts were
  localized. All init output is now driven by a locale message set (pt-BR / en) resolved from the
  language answer — "Próximos passos", "taxonomia do vault", "sensores semeados", etc. `src/init.mjs`.

## [0.25.1] — 2026-07-08

### Added
- **Landing page in the repo**: a static SVG hero (`docs/assets/wendkeep-hero.svg`, the knowledge
  graph) embedded at the top of the README, plus the self-contained interactive landing at
  `docs/index.html` (live Canvas graph; serve `docs/` via GitHub Pages for a public URL).

### Changed
- `wendkeep stats` now says **"N dias ativos (first→last)"** — the count is distinct days *with
  activity*, not the calendar span; the old "N dia(s)" read as calendar days.

## [0.25.0] — 2026-07-08

Cost trend/projection + shareable stats + launch assets.

### Added
- **`wendkeep cost --trend [day|week|month]`** — cost bucketed over time plus a run-rate
  **projection** (recent-window daily average × horizon). `wendkeep cost --write` generates a
  `00-Custo.md` trend note in the vault (by-month table + projection + top models). `src/cost.mjs`.
- **`wendkeep stats`** — one shareable line: sessions · prompts · spend · date span · models
  (`--json` too). For the npm page, a README badge line, or a post. `src/stats.mjs`.
- **Launch assets** (`docs/`): README hero (tagline, badges, quickstart, screenshot slot),
  Show HN / r/ObsidianMD / X post drafts (`docs/20-launch-posts.md`), and a repeatable
  graph-screenshot guide (`docs/21-graph-screenshot.md`).

## [0.24.0] — 2026-07-08

### Changed
- **No companion is pre-selected anymore.** `context-mode` was pre-checked (and the
  non-interactive default); wendkeep is a neutral harness and should not presume a third-party
  plugin. The interactive picker now starts with **nothing checked**, `init --yes` (and any
  non-interactive run) installs **no** companions, and `resolveCompanions({})` returns `[]`.
  Opt in explicitly — interactively (Space) or `--companions context-mode`. `src/taxonomy.mjs`.
- Prompt/help/README text updated to reflect the empty default.

## [0.23.0] — 2026-07-08

Vault structure — generated views + housekeeping (audit wave 2).

### Added
- **Generated Bases + Dashboard MOC**: `wendkeep init` now writes one folder-filtered `.base`
  per taxonomy area (sessions/decisions/bugs/learnings/specs/changes) and a `00-Dashboard.md`
  that embeds them — the vault's structural index. Filters are **by folder**
  (`file.inFolder("05-Bugs")`), fixing the tag-filter that hid ~1/3 of bugs. New
  `wendkeep dashboard [--force]` (re)generates them; non-destructive (never clobbers your own
  bases). Locale-aware. `src/vault-views.mjs`.

### Changed
- **Archive ADRs land in the dated month folder** (`04-Decisões/<year>/<MM-MMM>/`) alongside
  session-derived decisions, instead of the year root. `hooks/change-core.mjs`.
- **`SESSION_REGISTRY` is pruned** on the idle sweep: `done` entries older than 90 days, then a
  cap of 200 most-recent — active entries are never touched. Bounds the per-hook read/serialize
  cost that had grown to 330 entries / ~170 KB in production. `hooks/obsidian-common.mjs`.
- **Generated note names truncate on a word boundary** instead of mid-word (`slugify` gained a
  boundary-aware `maxLen`). `hooks/obsidian-common.mjs`, `hooks/linked-notes.mjs`.
- **Learnings dedup vault-wide**: a learning already recorded anywhere in `06-Aprendizados`
  (by `content_key`) is not re-emitted on a later day/session. `hooks/linked-notes.mjs`.

### Deferred
- Unifying the two `buildSessionContent` skeletons (session-start / session-ensure) stays as
  tracked tech-debt — pure refactor, high regression risk in the capture layer, and the
  user-facing drift (`session_id`) was already closed in 0.18/0.21.

## [0.22.0] — 2026-07-08

Hardening — 10 audit-confirmed bugs fixed (each survived an adversarial refuter).

### Fixed
- **Archive trusted stale evidence**: `verify` now seals `evidencia.json` with a `.evidence-hash`
  (the `tarefas.md` hash it ran against); the archive gate rejects evidence gone stale (a sensor
  task added/edited after the last green verify). `src/verify.mjs`, `src/change.mjs`.
- **Archiving a non-active change wiped the active pointer**: `archiveChange` now only clears
  `CURRENT_CHANGE` when the archived slug IS the active one. `hooks/change-core.mjs`.
- **Non-atomic archive**: a destination-exists guard fails BEFORE promoting specs (same-day slug
  reuse no longer half-promotes `07-Specs` then errors on the move); `renameSync` wrapped.
- **Archived proposta kept `status: active`** → flipped to `status: archived` on archive.
- **Import dropped Codex sessions whose `session_meta` exceeded 16KB** (~31% in production): the
  reader now grows the buffer to the first newline instead of a fixed prefix. `hooks/import-sessions.mjs`.
- **Cost was silently $0 for untabled models**: `normalizeModelName` strips a `[1m]` context tag
  generically (so `claude-opus-4-8[1m]` prices), `claude-sonnet-5` added, plus approximate Codex
  `gpt-5.4`/`gpt-5.3-codex` aliases. `hooks/token-usage.mjs`, `hooks/pricing.json`.
- **Imported session titles came from harness meta-prompts** ("Generate a concise title…"): those
  utility prompts are now filtered in both parsers' `shouldIgnoreUserText`.
- **Session↔change link died on reopen**: the change wikilink moved from an append after
  `## Encerramento` (stripped every turn) to a durable `## Mudanças` section before it, which
  accumulates every change the session touched. `hooks/session-stop.mjs`.
- **`init --force` duplicated every hook group**: now refreshes the managed entry in place instead
  of appending a second identical group. `src/init.mjs`.
- **Injected DIGEST carried dead wikilinks**: `buildBrainDigest` now keeps only targets that
  resolve to a real note and drops truncated placeholders. `hooks/brain-core.mjs`.

### Changed
- **Docs coherence**: `--help` moved `--top` from `import` to `cost`, gave `import` its real flags
  (`--source`/`--stamp-ids`/`--from`/`--codex-from`/`--limit`/`--dry-run`, "Claude + Codex"), and
  added `verify [--deep]`. README dropped the stale "v0.1" framing, fixed the 5→6 skill list
  (adds `wk-verify`), made the `docs/` link absolute, and documented the `<wk_process>` router +
  the G0 scaffold gate.

## [0.21.0] — 2026-07-08

Process enforcement — fixes from a real planning failure (production session): the model planned
in chat, never invoked the wk-* skills, left the change scaffold raw and archived it with
`--force`, minting a bogus ADR.

### Added
- **`<wk_process>` router injected every session** (brain-inject): the enforcement layer the
  skills were missing. Plan → wk-brainstorming + wk-planning; record → `change new` + FILL
  proposta/design/tarefas; implement → wk-tdd; close → verify + wk-verify + archive. States
  explicitly that `archive --force` is the user's call, never the agent's. Localized (pt-BR/en).
- **G0 — anti-scaffold gate**: `change archive` now blocks when proposta/design/tarefas still
  carry the scaffold placeholders (`(motivo da mudança)`, `(abordagem técnica)`,
  `(primeira tarefa)` + en variants) — an unfilled scaffold is not a completed change.
  `--force` still escapes (human hatch); new `scaffoldPlaceholders(dir)` in change-core.

### Fixed
- **session-ensure now stamps `session_id`** in the notes it creates — the 4th note-creation
  path, missed in 0.18.0 (it has its own skeleton builder). Notes born from UserPromptSubmit
  (no SessionStart, e.g. resumed windows) were coming out without identity.

## [0.20.1] — 2026-07-06

### Changed
- The interactive (and text-fallback) companion picker in `wendkeep init` **no longer lists
  dotcontext**. The native a2 loop replaces it, so leaving it in the prompt was just clutter. It
  stays reachable for anyone already invested via an explicit `--companions dotcontext` — the
  hiding is UI-only (`resolveCompanions` still honors the id). New `selectableCompanions()` helper
  drives the picker.

## [0.20.0] — 2026-07-06

Richer skills: bundled templates (multi-file).

### Added
- The process skills now ship **bundled templates** next to their `SKILL.md`, delivered together
  by `sync-defs` (the whole skill folder is copied) and auto-delivered by `init`. The model reads
  them on demand — depth without bloating `SKILL.md`:
  - **wk-verify** → `spec-reviewer-prompt.md` (the prompt to hand a fresh read-only verifier
    sub-agent) + `verdict-template.json` (the exact `verdict.json` shape).
  - **wk-planning** → `plan-template.md` (file map + bite-sized TDD task structure).
  - **wk-brainstorming** → `design-template.md` (context, approaches, signed-off assumptions,
    out-of-scope table, acceptance).
  - pt-BR and en variants; the prose templates follow the vault locale, the JSON is shared.

### Notes
- Subagents stay the **native harness's** job. wendkeep ships the verifier **prompt** (the agent
  spawns a read-only sub-agent via its own Task/Agent tool) and captures subagent telemetry — it
  does not orchestrate spawning. So the reviewer is a template, not a Claude-only
  `.claude/agents/*.md`, which keeps it agent-agnostic.

### Upgrade
- `npm update wendkeep`, then `wendkeep init` (or `wendkeep sync-defs`) to get the templates
  alongside your existing skills. Non-destructive — existing `SKILL.md` files are never overwritten.

## [0.19.0] — 2026-07-06

Fix: memory + active-change injection wired by default.

### Fixed
- `wendkeep init` now wires the **`brain-inject`** hook into SessionStart (ordered *before*
  `session-start`), so every session gets `<brain_memory>` injected: CORE + DIGEST + the
  **active change** (proposal + open tasks) + project lessons. Previously the default hook set was
  only `session-start` / `session-stop` / `session-ensure` — the memory/change injector existed
  (`wendkeep hook brain-inject`) but wasn't wired, so the "the change is injected at the next
  SessionStart" promise (the `wk-workflow` skill and the README) didn't actually hold on a fresh
  install. matcher `startup|clear|compact` re-injects after a compaction or clear, not only on a
  cold startup.

### Upgrade
- Existing installs pick it up by re-running `wendkeep init --force` (idempotent — it only adds the
  missing hook), or by adding `npx wendkeep hook brain-inject` to the SessionStart hooks manually.

## [0.18.0] — 2026-07-06

Session identity in the note.

### Added
- Session notes now carry **`session_id`** in their frontmatter — both live capture and import,
  Claude and Codex. Pairs with the existing `provider:` field so every note self-identifies
  (which conversation, which agent) without consulting the registry.
- **`wendkeep import --stamp-ids`** — backfill `session_id` into existing notes from the
  `SESSION_REGISTRY` (for notes captured or imported before the field existed). Idempotent;
  only touches notes missing the field.
- Import dedup now also scans existing notes' `session_id` (`capturedSessionIds` = registry ∪
  note frontmatter), so a session that already has a note on disk is never re-imported even if
  the registry was reset or lost.

### Changed
- `buildSessionContent` accepts a `sessionId`; the SessionStart hook (all three create/recreate
  paths) and `importSession` thread the id through, so a note records its identity at creation.

## [0.17.0] — 2026-07-06

Retroactive memory, now agent-agnostic (Codex).

### Added
- **`wendkeep import --source codex|all`** — import now covers **Codex** too. Codex rollouts
  (`~/.codex/sessions/**`) aren't organized by project, so they're scoped by the `cwd` recorded
  in each session's `session_meta` — matched case- and separator-insensitively, including
  subdirectories. `--source` defaults to **`all`** (both agents); narrow with `claude` / `codex`.
  `--codex-from <dir>` overrides the sessions root.
- Transcript parsers now carry a `provider` field, so an imported note is tagged with the
  transcript's **real** provider (`provider: codex` for Codex) instead of the ambient default.

### Changed
- `wendkeep import` default source is now **`all`** (was Claude-only in 0.16.0). Still idempotent —
  already-imported sessions are skipped by `session_id`, per project (Claude by slug dir, Codex by
  `session_meta.cwd`).
- Import registration keys off the **discovered** `session_id` (filename for Claude,
  `session_meta.id` for Codex) so the dedup key and the registry key are always identical —
  closes a latent duplicate-on-reimport gap if a transcript's filename ever diverged from its
  internal id.
- Validated on real data: **24** Codex sessions discovered for a production project (across
  drive-case variants), 0 parse errors, notes correctly tagged `codex`.

## [0.16.0] — 2026-07-06

Retroactive memory.

### Added
- **`wendkeep import`** — backfill the vault with this project's *past* Claude Code sessions.
  It scans `.claude/projects/<slug>/*.jsonl`, and for every session not already in the vault
  (deduped by `session_id` against the `SESSION_REGISTRY`) reconstructs a full, dated session
  note — frontmatter, one iteration block per turn, cost + subagent telemetry, derived
  decision/bug/learning notes, and a finalized closing — placed in its **real** date folder
  (`02-Sessões/<year>/<MM-MMM>/DIA <dd>/`), not today's. One command turns your whole history
  into memory that `wendkeep cost` immediately aggregates.
  - Offline replay of the live capture flow (same `buildSessionContent` / `insertIteration` /
    `finalizeSessionFile` / usage + subagent code) so an imported note is indistinguishable
    from a captured one.
  - Options: `--from <dir>` (point at the `.claude/projects` folder explicitly), `--project`,
    `--since <date>`, `--limit <n>`, `--dry-run` (report without writing), `--json`.
  - Idempotent: re-running skips everything already imported. Never overwrites an existing note.
  - v1 covers Claude Code transcripts; Codex is a follow-up.

### Changed
- `session-start.mjs` now guards its `main()` behind the standard `import.meta.url` check (like
  `session-stop.mjs`) so its note-building helpers can be imported by `import`/tests without
  running the hook. No behavioral change when invoked as a hook.

## [0.15.0] — 2026-07-06

### Added
- **`wendkeep cost --top [N]`** — the N priciest sessions (cost incl. subagents · date · file),
  most expensive first (default 10). Spot where the money went. `cost --json` now also carries
  the per-session `sessions` list.

## [0.14.0] — 2026-07-06

### Changed
- **dotcontext is no longer a default companion.** wendkeep's native a2 loop (`change` /
  `verify` / gate) recreates dotcontext's execution/gate role, so pinning it duplicates the
  harness. The interactive / `--yes` default is now **`context-mode` only**; dotcontext stays
  selectable via `--companions dotcontext` for anyone already invested.
- **README:** rewrote "Install & set up" with a clear **`init` options table** and a
  per-companion breakdown; clarified that `--no-mcp` skips **only wendkeep's own** vault MCP
  (companion MCPs still follow `--companions`).

## [0.13.0] — 2026-07-06

Cost intelligence: waste + average.

### Added
- **Wasted-spend tracking:** a killed/failed workflow run's subagent cost is now recorded per
  session (`subagents_wasted_usd` + a line in the note's `## Subagents & Workflows`) and rolled
  up by `wendkeep cost` (`desperdiçado (runs killed/failed): $X`). Money burned on aborted runs
  was invisible before.
- **`wendkeep cost` per-session average** (`$/sessão`) alongside the vault total.

## [0.12.0] — 2026-07-06

Deeper subagent/workflow telemetry.

### Added
- **Workflow run metadata** in the `## Subagents & Workflows` section: each run now shows its
  **status** (completed / killed / …), phase titles, duration and agent count — read from the
  authoritative `workflows/wf_*.json`. On a real session this surfaced a **killed** run that
  still cost $2.50 next to the completed $5.76 one — wasted spend you couldn't see before.
- **Subagent tools rollup:** the distinct tools the subagents used, shown in the section and a
  new `subagents_tools` frontmatter field.

## [0.11.0] — 2026-07-06

Vault-wide cost.

### Added
- **`wendkeep cost`** — aggregate AI-coding spend across every session note in the vault:
  total (main + subagents), by model, by day. `--since <YYYY-MM-DD>` to window; `--json` for
  scripting. Builds on the per-session cost the capture hooks already record — on a real
  project vault it surfaced **~$4.7k across 140 sessions** in one command.

## [0.10.0] — 2026-07-06

Subagent & workflow telemetry — closing the biggest observability gap.

### Added
- **Subagent + workflow capture:** the Stop hook now scans the session's sibling subagent
  transcripts (`<session>/subagents/**`) and workflow runs, and folds them into the session
  note — a new `## Subagents & Workflows` section (aggregate + a collapsible per-subagent
  table) plus frontmatter fields (`subagents_count`, `subagents_tokens_total`,
  `subagents_custo_usd`, `tokens_total_incl_subagents`). Reuses the token-usage parser
  (deduped per request). Previously a session that spawned a Workflow recorded ONLY the main
  transcript — on a real audit session that hid **12 subagents / 4.6M tokens / $7.59** (2× the
  main). The main `tokens_total` stays the main agent's (comparable to Claude Code's own
  display); subagents are a separate axis.
- Provider-gated by structure (Claude Code's `subagents/` layout); fail-open — never blocks Stop.

## [0.9.1] — 2026-07-06

Interactive install UX: language first.

### Added
- **`wendkeep init` asks the vault language first** on an interactive TTY (when `--locale`
  isn't passed): `[1] Português  [2] English`. The answer drives the folders, scaffold and
  skills — and the remaining prompts (vault path, companion selection) now render in the
  chosen locale instead of always Portuguese. `--yes`, `--locale` and non-TTY are unchanged.

## [0.9.0] — 2026-07-06

Engineering debt: sensor editing + i18n coherence for auto-generated notes.

### Added
- **`wendkeep sensors add <id> "<command>"`** (`--severity` / `--type` / `--report` / `--name`
  / `--description`) — append a sensor to `wendkeep.sensors.json` (creates the file with
  `$schema` when absent, dedups by id) instead of hand-editing JSON.
- **Locale-aware derived notes:** the auto-generated bug/decision/learning notes render their
  headings + callout in the vault locale — an `en` vault no longer gets Portuguese headings.

### Deferred (with reason)
- `migrate-locale`: renaming a populated vault breaks every wikilink to the old folder names;
  needs a backlink-repair pass — its own effort, not a patch.
- Code-hash verdict freshness: a change carries no file manifest, so "the code" is undefined;
  the existing `tarefas.md` hash already blocks task drift.

## [0.8.1] — 2026-07-06

Polish: i18n coherence + presentation.

### Added
- **Locale-aware process skills + vault docs:** an `en` vault now seeds the `wk-*` skills,
  the vault README, the change template, and the specs README in English (previously
  Portuguese regardless of locale). Completes the `--locale en` promise.
- **`wendkeep.sensors.json` at the repo root** — the project gates itself with its own
  test/check sensors (dogfooding the harness).

### Changed
- npm `description` now describes the harness + a2 loop (was capture-only).
- CI: `actions/checkout` and `actions/setup-node` bumped to `v5` (v4 runner deprecation).
- README: the i18n "known limitation" is resolved.

## [0.8.0] — 2026-07-05

Reach: internationalization + agent-agnostic distribution.

### Added
- **Vault locale (i18n):** `wendkeep init --locale en` creates an English vault
  (`02-Sessions`, `04-Decisions`, `08-Changes`, …, English months, English change scaffold,
  English CORE skeleton, localized theme/graph groups). The locale is a vault property
  (`.brain/config.json`), locked at init; absent = `pt-BR` — existing vaults are untouched
  and never renamed. Parsers are **bilingual everywhere** (`Requisito|Requirement`,
  `mata mutante|kill mutant`, CORE section sets), so mixed content never breaks.
- **AGENTS.md managed section:** `sync-defs`/`init` maintain a marker-delimited section in
  the project's `AGENTS.md` (loop summary + skill inventory) — one file that Codex, Amp,
  Cursor, Zed and any AGENTS.md-reading agent picks up. User content around it is preserved.
- **Harness contract v1.2** (`docs/14`): locale + AGENTS.md channel.

### Deferred
- Extra mutation-report formats (mutmut/PIT) and per-agent session-hook wiring — backlog
  (`docs/17`).

## [0.7.0] — 2026-07-05

Ergonomics: the loop without hand-editing files.

### Added
- **`change status`** — one screen: tasks (done/open with `[req:]`/`[sensor:]`), sensor
  evidence, verdict state (ok / stale / incomplete / absent), mutation round.
- **`change done <id>` / `undone <id>`** — tick tasks from the CLI (exact-id anchored).
- **`change diff`** — dry-run preview of the spec promotion (`+` ADDED / `~` MODIFIED /
  `-` REMOVED / `!` warnings) without touching `07-Specs`.
- **`spec list` / `spec show <capability>`** — read-only views over the living specs.
- **`sensors list`** — the sensors from `wendkeep.sensors.json`; a **JSON Schema** for the
  file now ships in the package (`schema/`) and the init seed points `$schema` at it.
- README: "the loop in five minutes" worked example.

### Fixed
- `change` subcommands without a positional argument no longer mistake the `--vault` value
  for a slug.

## [0.6.1] — 2026-07-05

Hardening: CI + real-world gate holes found by self-audit.

### Added
- **CI (GitHub Actions):** test + check matrix on ubuntu/windows × Node 18/20/22.
- **Open-task gate:** `change archive` blocks while tasks are open (`- [ ]`, including mutation
  fix-tasks `M.n` — a surviving mutant can no longer be archived). Explicit escape: `--force`.
- **Freshness seal (`tasksHash`):** `verify --deep` fingerprints `tarefas.md` into the package
  and verdict; the gate rejects a verdict minted against different tasks as stale. Pre-0.6.1
  verdicts (no hash) still accepted.
- **Auto-lesson on mutation escalation:** the 3rd surviving round records a project-local lesson.
- **Session link in proposta:** `change new` fills `source:` with the active session (graph edge
  proposta → sessão).

### Fixed
- `.mutation-round` now resets when the report comes back clean (a future survivor starts a
  fresh 3-round cycle instead of instantly escalating).
- `verify` exits 1 when mutants survive (was 0 — CI couldn't see it).
- `.brain/lessons/` capped at 50 (oldest pruned) instead of growing unbounded.

## [0.6.0] — 2026-07-05

Enforcement layer (Wave B of the TLC-parity program) — closes TLC parity.

### Added
- **Discrimination sensor (`type: mutation`):** delegates to the project's mutation tool and
  parses its mutation-testing-elements report; surviving mutants become fix tasks in the active
  change (`- [ ] M.n mata mutante file:line`), bounded to 3 rounds before escalating.
- **Harness self-check:** `wendkeep doctor` now validates the a2 state — an invalid
  `wendkeep.sensors.json`, a broken `CURRENT_CHANGE` pointer, changes without a `proposta.md`,
  an orphan `[req:]` (unknown requirement), and stale verdicts.
- **Lessons loop:** `wendkeep lesson add "<trigger>" "<lesson>"` records a project-local lesson in
  `.brain/lessons/`; `brain-inject` surfaces the recent ones as a `<lessons>` block at SessionStart.
- **Auto-sizing:** `wendkeep change new <slug> --simple` scaffolds only proposta + tarefas
  (no design / spec-delta) for trivial changes.
- **Harness contract v1.1** (`docs/14-harness-contract.md`): the mutation + lesson formats.

## [0.5.0] — 2026-07-05

Verification & credibility layer (Wave A of the TLC-parity program). The gate stops being
"green sensors" alone and starts requiring an independent verdict for changes that touch a spec.

### Added
- **Requirement IDs + traceability:** living-spec requirements carry a stable ID
  (`### Requisito: GATE-1 — nome`); tasks reference them with `[req:<ID>]`; the archive ADR
  lists the requirements it satisfied. Rastro req → task → verdict → ADR.
- **`wendkeep verify --deep`:** assembles a verification package (`verificacao.json`) for an
  independent pass. A trivial change (no `[req:]`, sensors green) gets an auto verdict.
- **Independent verdict gate:** `change archive` now also requires `verdict.json` (`ok`, covering
  every declared `[req:]`) for requirement-bearing changes.
- **TLC-grade process skills:** rewrote `wk-tdd` (spec-derived assertions, non-shallow litmus,
  test adequacy, test-learning) and `wk-brainstorming` (closure gate + out-of-scope); new
  `wk-verify` (fresh read-only verifier, author≠verifier).
- **Harness contract v1** (`docs/14-harness-contract.md`): the extension-point formats.

### Changed
- Requirement-less changes are unaffected — the sensor gate remains their proof. The verdict
  requirement applies only when a change declares `[req:]` tasks. Specs from 0.4.0 (headings
  without an ID) stay valid.

## [0.4.0] — 2026-07-05

Spec promotion (the living contract) + harness fixes.

### Added
- **Spec promotion** — `wendkeep change archive` merges each capability's spec delta
  (`## ADDED` / `## MODIFIED` / `## REMOVED Requirements`) into the living
  `07-Specs/<capability>.md`. Multi-capability per change via `specs: [slugs]` in the
  proposta; the living spec footer wikilinks the archived change (`hooks/spec-core.mjs`).
- Change scaffold now seeds an example spec delta at `specs/exemplo/spec.md`.
- `wendkeep change archive` prints promoted capabilities and surfaces delta warnings
  (ADDED-already-exists / MODIFIED-missing) without blocking.

### Changed
- `wendkeep init` now runs `sync-defs` itself — process skills and agents are delivered
  to `.claude/skills` / `.codex/agents` immediately (no manual step).
- The archive gate and `wendkeep verify` share one rule: only **critical** (or missing)
  sensors block; a red `warning` sensor is advisory. Evidence records each sensor's severity.
- README documents the change/verify/skills commands and the a2 loop.

## [0.3.0] — 2026-07-05

The a2 native harness — a zero-dependency spec→change→proof loop on the vault memory
core (recreates the best of OpenSpec + dotcontext + superpowers, natively).

### Added
- **Pilar B — change lifecycle:** `wendkeep change new|list|show|archive`. Scaffolds
  `08-Mudanças/<slug>/` (proposta/design/tarefas); the active change is injected at the
  next `SessionStart`; archive moves the change to `_arquivo/` and mints an ADR in
  `04-Decisões/`. New vault folders `07-Specs/`, `08-Mudanças/` (`hooks/change-core.mjs`).
- **Pilar C — verify + gate:** `wendkeep verify` runs a change's task-declared sensors
  (`[sensor:<id>]` hints) from a native `wendkeep.sensors.json`, records `evidencia.json`;
  `change archive` gates on the evidence (`hooks/sensors-core.mjs`).
- **Pilar A — process skills:** native `wk-workflow` / `wk-tdd` / `wk-debugging` /
  `wk-brainstorming` / `wk-planning` seeded into `.brain/skills` (`src/skills-seed.mjs`).

## [0.2.7] — 2026-06-30

### Added
- **Definitions layer:** `.brain/agents/` + `.brain/skills/` as versioned source of truth,
  copied into the project with `wendkeep sync-defs`.
- **dotcontext seed:** a starter `.context/config/sensors.json` (a `validate-memory` sensor
  plus one per detected `package.json` script) when the dotcontext companion is selected.

## [0.2.1] – [0.2.6] — 2026-06-29

Rapid iteration on the companion + memory layers (same day):
- **Companions** wired the most agent-agnostic way (context-mode / dotcontext as MCP,
  understand-anything via a domain-graph SessionStart injector, caveman via installer).
- **Obsidian color system** — a mode-agnostic CSS snippet (note-type accents) + graph
  color groups, merged non-destructively into `.obsidian/`.
- **Curated memory protocol** — `.brain/CORE.md` + `COMPACTION_PROTOCOL.md` and
  `wendkeep validate-memory` (cap 25 lines, 3 sections, no secrets/PII).
- Cross-platform caveman installer fix (npx non-interactive; Gemini excluded).
- Derived notes grouped by month under the year.

## [0.2.0] — 2026-06-29

### Added
- Companion plugins/MCP selection in `wendkeep init` (context-mode, understand-anything,
  caveman) with idempotent settings/`.mcp.json` merging.

## [0.1.0] — 2026-06-29

Initial release — the capture engine, extracted from a system in daily production use.

### Added
- Automatic session capture (`SessionStart` / `UserPromptSubmit` / `Stop` hooks) into
  `02-Sessões/` as turn-by-turn Markdown.
- Multi-agent provider detection (Claude Code, Codex, Copilot).
- Token & cost tracking (cache-aware `pricing.json`).
- Auto-extracted derived notes (decisions / bugs / learnings), backlinked to the session.
- Curated memory (`.brain/` cold index + `CORE` + `DIGEST` injected at `SessionStart`).
- `wendkeep init` (cross-platform installer) + optional `@bitbonsai/mcpvault` MCP server.

<!-- Only v0.4.0+ is tagged in git (history starts here); older versions link to npm. -->
[0.15.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.15.0
[0.14.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.14.0
[0.13.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.13.0
[0.12.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.12.0
[0.11.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.11.0
[0.10.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.10.0
[0.9.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.9.1
[0.9.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.9.0
[0.8.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.8.1
[0.8.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.8.0
[0.7.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.7.0
[0.6.1]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.1
[0.6.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.6.0
[0.5.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.5.0
[0.4.0]: https://github.com/rogersialves/wendkeep/releases/tag/v0.4.0
[0.3.0]: https://www.npmjs.com/package/wendkeep/v/0.3.0
[0.2.7]: https://www.npmjs.com/package/wendkeep/v/0.2.7
[0.2.0]: https://www.npmjs.com/package/wendkeep/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/wendkeep/v/0.1.0
