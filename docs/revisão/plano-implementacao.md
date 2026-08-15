# Plano futuro de implementação no WendKeep

## Objetivo

Fazer com que cada turno terminado seja projetado exatamente uma vez na nota de sessão ou
tenha um estado durável explicando por que não foi projetado.

## Fora de escopo desta revisão

- Não corrigir a sessão/transcript de referência.
- Não editar nota, transcript ou registro do projeto consumidor.
- Não atualizar dependência do projeto consumidor antes da validação no WendKeep.

## Fase P0-A — cerca de escopo e autorização Git

Esta fase deve preceder qualquer correção de iteração porque o incidente demonstrou um risco
de mutação no repositório errado mesmo quando o Vault da sessão continuou correto.

### Contrato de escopo

Adicionar ao contexto de execução e ao registro da sessão, de forma sanitizada:

`session_id`, `project_id`, `project_root`, `repo_root`, remoto, branch, provider e change ativa.

No resume/compactação, o WendKeep deve comparar esse contrato com o `cwd` real e com
`git rev-parse --show-toplevel`, `git remote get-url origin` e branch atual. Divergência deve
interromper a ação mutável e pedir seleção explícita do projeto.

### Gate de ferramenta

O gate precisa alcançar todas as superfícies que podem chamar shell ou Git, inclusive execução
aninhada por MCP/`exec`, e não somente um matcher de Bash. Deve bloquear por padrão:

- `git add`, `commit`, `push`, `pull`, `merge`, `checkout`, `reset`, `revert` e remoções;
- qualquer comando cujo `workdir` não corresponda ao `repo_root` da sessão;
- qualquer branch ou remoto diferente do contrato atual.

Uma troca deliberada de projeto deve ser explícita, com projeto, caminho, remoto e branch
confirmados, e deve criar um novo lease de ação.

### Autorização granular

Separar autorizações para `commit`, `push`, `pull`, merge e publicação. A confirmação deve
repetir o alvo completo; frases genéricas como “continuar”, “prosseguir” ou “puxa” não podem
ser reutilizadas depois de uma mudança de contexto. A autorização expira ao fim da operação
ou do turno.

### Concorrência

Detectar sessões ativas que compartilham `project_id`, `repo_root` e branch. Para escrita
concorrente, exigir worktrees distintas ou negar a operação. `CURRENT_SESSION.md` continua
sendo apenas uma visão operacional.

### Testes discriminantes

Criar casos para:

1. sessão de projeto consumidor com change/contexto WendKeep pendente;
2. duas sessões Codex ativas em projetos diferentes;
3. `workdir` divergente em shell direto, MCP e execução aninhada;
4. autorização de commit sem autorização de push;
5. pedido ambíguo de “puxa”;
6. resume/compactação com mudança de projeto;
7. tentativa de operar no branch remoto errado.

Critério de saída: a tentativa cruzada é negada antes do Git mutar qualquer estado e produz
diagnóstico com sessão, projeto, `cwd`, remoto e branch, sem payload sensível.

## Fase P0 — instrumentação e reprodução

Arquivos candidatos:

- [hooks/session-stop.mjs](../../hooks/session-stop.mjs);
- [hooks/session-note-io.mjs](../../hooks/session-note-io.mjs);
- [hooks/subagent-stop.mjs](../../hooks/subagent-stop.mjs);
- novos testes em `tests/`.

Implementar primeiro uma trilha estruturada, sem prompt ou payload sensível, contendo:

`session_id`, `transcript_id`, `turn_id`, `turn_sequence`, hook, etapa, resultado, lock status,
duração e timestamp.

Reproduzir com fixture sanitizada:

1. 10 turnos com sequência causal contínua;
2. turno interrompido com `turn_aborted`;
3. `Stop` concorrente com `SubagentStop`;
4. lock ocupado durante `insertIteration()`;
5. saída antecipada após staging de memória;
6. observabilidade com fronteira atrasada.

Critério de saída: cada caso informa explicitamente se o turno foi `inserted`, `duplicate`,
`aborted`, `skipped`, `busy` ou `failed`.

## Fase P1 — normalização do parser

Arquivos candidatos:

- [packages/integrations/src/transcripts.mjs](../../packages/integrations/src/transcripts.mjs);
- [hooks/token-usage.mjs](../../hooks/token-usage.mjs);
- [packages/integrations/src/transcript-usage.mjs](../../packages/integrations/src/transcript-usage.mjs).

Mudanças:

- classificar `subagent_notification` como evento sintético, sem tratá-lo como prompt;
- tratar `turn_aborted` com estado explícito do turno;
- reconhecer `custom_tool_call` e `custom_tool_call_output`;
- reconhecer eventos MCP relevantes sem contar a mesma chamada duas vezes;
- associar todos os eventos ao `turn_id` do evento, não apenas ao último turno global;
- compartilhar uma normalização única entre transcript e token usage.

Testes obrigatórios:

- prompt humano seguido de notificação de subagente;
- `custom_tool_call` de `exec`;
- chamada com saída correspondente;
- evento sem `turn_id` e evento com `turn_id` explícito;
- transcript truncado e transcript interrompido.

## Fase P2 — gravação confiável da iteração

Arquivos candidatos:

- [hooks/session-stop.mjs](../../hooks/session-stop.mjs);
- [hooks/session-note-io.mjs](../../hooks/session-note-io.mjs);
- [hooks/import-sessions.mjs](../../hooks/import-sessions.mjs);
- [hooks/session-backfill.mjs](../../hooks/session-backfill.mjs).

Mudanças:

1. Fazer `insertIteration()` retornar o resultado estruturado de `mutateSessionNote()`.
2. Aplicar retry limitado e determinístico para `busy` dentro do orçamento do hook.
3. Se o retry falhar, gravar uma pendência durável para replay posterior.
4. Só atualizar `last_logged_turn_id` depois da confirmação da escrita.
5. Preservar a deduplicação por marcador `wk-turn`.
6. Registrar uma iteração diagnóstica para `aborted`, `skipped` ou `ambiguous`, sem inventar
   conteúdo do usuário.
7. Garantir que `Stop` e `SubagentStop` não possam apagar o resultado um do outro.

Invariante:

```text
terminal turn
  -> exatamente um wk-turn
  OU
  -> um estado durável com motivo e turno associado
```

## Fase P3 — publicação e ciclo de vida

Arquivos candidatos:

- [hooks/session-observability.mjs](../../hooks/session-observability.mjs);
- [hooks/session-observability-store.mjs](../../hooks/session-observability-store.mjs);
- [hooks/session-stop.mjs](../../hooks/session-stop.mjs);
- [hooks/session-start.mjs](../../hooks/session-start.mjs);
- [hooks/session-ensure.mjs](../../hooks/session-ensure.mjs).

Mudanças:

- propagar `stale`, `conflict`, `degraded`, `missing` e `busy` como estados observáveis;
- persistir diagnóstico e fronteira pendente para reconciliação;
- reconciliar registro, frontmatter e seção de metadados da nota;
- decidir formalmente se `Stop` é checkpoint ou encerramento definitivo;
- alinhar `active/done` entre nota, registro e visão `CURRENT_SESSION`;
- manter `CURRENT_SESSION` como visão, nunca como identidade primária de escrita.

## Fase P4 — validação e rollout

Executar no WendKeep:

1. testes unitários dos parsers;
2. testes de lock e corrida entre hooks;
3. replay integral da fixture de 10 turnos;
4. suíte oficial;
5. `wendkeep verify`;
6. `wendkeep verify --deep` com verificador independente;
7. PR separado para a implementação.

Critérios de aceite:

- os 10 turnos da fixture têm marcador ou motivo durável;
- o turno interrompido não desaparece silenciosamente;
- nenhuma notificação de subagente aparece como pedido humano;
- `exec` e ferramentas MCP aparecem corretamente na observabilidade;
- lock ocupado produz retry ou pendência recuperável;
- replay é idempotente;
- `observability_dirty` é resolvido ou possui diagnóstico e caminho de recuperação;
- nenhum segredo ou payload privado é gravado nos diagnósticos;
- uma sessão não executa Git em outro projeto sem troca de escopo confirmada e auditável;
- `commit`, `push` e `pull` exigem autorizações separadas;
- execução via Codex/MCP recebe o mesmo gate que execução Bash;
- sessões paralelas não compartilham mutação no mesmo repo/branch sem worktree isolada.

## Dependência do projeto consumidor

Somente após o WendKeep passar pelos gates acima:

- atualizar a versão do pacote em change separada;
- validar novamente os hooks no checkout consumidor;
- não reparar a sessão antiga por edição manual antes de preservar a evidência.
