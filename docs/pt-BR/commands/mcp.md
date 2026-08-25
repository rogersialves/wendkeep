# MCP nativo

[English](../../en/commands/mcp.md)

## Objetivo

Expor estado semântico local de projeto, contexto, memória, changes, tarefas, evidência e Observer
sem leitura arbitrária do filesystem ou dependência dinâmica `@latest`.

## Quando usar

Use quando um cliente MCP precisar descobrir e consultar o WendKeep ou executar um write causal
explicitamente autorizado por capability, active context e lease.

## Quando não usar

Não use para delivery, merge, push, tag, publicação, exclusão ou acesso genérico a arquivos. Essas
operações ficam fora da superfície padrão e continuam nos fluxos CLI/ASSURE apropriados.

## Pré-requisitos

- pacote `wendkeep` instalado no projeto ou acessível pelo binário;
- binding válido de projeto↔Vault;
- Node.js 18+ para Core; Node.js 22.13+ somente para Observer SQL;
- para writes: sessão causal, active context e autorização vigentes.

## Sintaxe

```powershell
wendkeep mcp serve --vault <vault>
wendkeep mcp serve --vault <vault> --timeout-ms <n>
wendkeep mcp config --client generic --vault <vault>
wendkeep mcp config --client claude --vault <vault>
wendkeep mcp config --client codex --vault <vault>
wendkeep mcp config --client cursor --vault <vault>
```

## Opções e códigos de saída

- `--vault <path>` seleciona o Vault; é obrigatório em `config` e opcional em `serve`. Sem a
  flag, o stdio inicia sem depender do checkout do processo e resolve o binding/auditoria de cada
  chamada somente pelo `project_root` declarado; um projeto nunca reutiliza o auditor de outro.
- `--timeout-ms <n>` aceita 1 a 120000; padrão 10000 por chamada.
- `--client` aceita `generic`, `claude`, `codex` ou `cursor`.
- Exit 0: transporte/configuração concluído; Exit 2: subcomando, cliente ou opção inválida.
- Tool errors usam resultado MCP `isError` com `schema_version: 1`, código `MCP_*`, mensagem
  sanitizada e `retryable`; não encerram o servidor.

## Exemplos

O `init` gera a entrada genérica reproduzível:

```json
{
  "mcpServers": {
    "wendkeep-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "wendkeep", "mcp", "serve", "--vault", "<vault>"]
    }
  }
}
```

Reads: `wendkeep_project_status`, `wendkeep_context_status`, `wendkeep_memory_recall`,
`wendkeep_memory_conflicts`, `wendkeep_change_list`, `wendkeep_change_show`,
`wendkeep_change_status`, `wendkeep_spec_effective`, `wendkeep_task_show`,
`wendkeep_task_evaluate`, `wendkeep_handoff_current`, `wendkeep_evidence_latest` e
`wendkeep_observer_query`.

Writes: `wendkeep_memory_assert`, `wendkeep_checkpoint_create`, `wendkeep_context_select`,
`wendkeep_task_claim`, `wendkeep_task_complete` e `wendkeep_handoff_publish`.

## Resultado esperado

O handshake e `tools/list` retornam JSON-RPC válido. Cada tool declara effect/capability e schemas
versionados. Reads conhecidas não entram no mutation gate, mas mantêm binding explícito de
projeto/worktree, paginação por cursor, budget padrão de 1 MiB, redaction, timeout e cancelamento.
Observer aparece indisponível abaixo de Node 22.13 sem impedir Core no Node 18.

Writes exigem `project_root`, `session_id`, `active_context_id`, `actor`, `reason`, capability exata
e `lease.id`/`lease.expires_at`; o executor revalida a autorização causal e os gates da CLI. A
auditoria local `.brain/runtime/MCP_AUDIT.jsonl` guarda somente tool, effect, capability, resultado,
código e duração — nunca argumentos ou payload.

## Erros comuns e diagnóstico

- `MCP_TOOL_UNKNOWN`: tool/alias não consta no catálogo verificado; atualize o cliente ou pacote.
- `MCP_CAPABILITY_REQUIRED` / `MCP_SCOPE_AUTH_REQUIRED`: capability ausente ou não autorizada.
- `MCP_LEASE_EXPIRED`: obtenha autorização/lease nova; não altere timestamp manualmente.
- `MCP_PROJECT_SCOPE_MISMATCH`: `project_root` e `worktree_root` pertencem a bindings diferentes.
- `MCP_REQUEST_TOO_LARGE` / `MCP_RESPONSE_TOO_LARGE`: use `limit` e o cursor retornado.
- `MCP_RUNTIME_UNSUPPORTED`: use Node 22.13+ para Observer; Core permanece disponível.

## Próximos passos

Rode `wendkeep mcp config --client <client> --vault <vault>`, instale o snippet no cliente e faça
`initialize` → `tools/list` → uma read conhecida. Para identidade causal, veja [Contexto](context.md);
para o backend SQL opcional, veja [Observer](observer.md).
