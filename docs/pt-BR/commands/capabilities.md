# Capacidades dos hosts

[English](../../en/commands/capabilities.md)

## Objetivo

Mostrar a matriz versionada das 17 capacidades de lifecycle e efeitos que cada host realmente
oferece como `native`, `adapted`, `polled`, `manual` ou `unavailable`.

## Quando usar

Use antes de depender de hooks de sessão, tool use, conclusão de tarefa, subagentes, transcript ou
usage; e ao diagnosticar diferenças entre Claude Code, Codex, Pi e clientes MCP/CLI genéricos.

## Quando não usar

Não use a matriz como prova de que um evento manual ocorreu. Estado `manual` tem autoridade apenas
`reported`; somente eventos native/adapted/polled podem ser `verified`.

## Pré-requisitos

Node.js 18+ e o pacote WendKeep instalado. O comando é puro e não requer Vault. A cobertura gravada
na sessão usa o host detectado e pode receber a versão por `WENDKEEP_HOST_VERSION`.

## Sintaxe

```text
wendkeep capabilities [--host <claude|codex|pi|generic-mcp>] [--host-version <v>] [--json]
```

Sem `--host`, o comando lista todos os manifests. Host desconhecido degrada explicitamente para
`generic-mcp`; versão fora da faixa fica `HOST_VERSION_UNPROVEN`.

## Opções e códigos de saída

- `--host <id>` seleciona um host; ids desconhecidos não são promovidos silenciosamente.
- `--host-version <v>` compara o major observado com o manifest.
- `--json` emite o contrato `host-coverage-v1`.
- exit `0`: matriz emitida; exit `2`: argumento inválido.

`wendkeep.sensors.json` pode declarar `requires_host_capabilities` e waivers humanos explícitos em
`host_capability_waivers`. `verify` sai `1` se uma capacidade requerida estiver manual/unavailable
sem waiver com `authority: human`, `approved_by` e `reason`. ASSURE aplica a mesma regra ao handoff.

## Exemplos

```powershell
wendkeep capabilities --host codex --host-version 1.2.0
wendkeep capabilities --host generic-mcp --json
```

```json
{
  "requires_host_capabilities": ["task.completed"],
  "host_capability_waivers": [{
    "capability": "task.completed",
    "authority": "human",
    "approved_by": "maintainer",
    "reason": "confirmação manual"
  }]
}
```

## Resultado esperado

A cobertura entra no registro da sessão, active context, handoff, envelope de evidência e resumo do
Observer. Lacunas são injetadas no contexto no início, antes que o agente assuma paridade inexistente.
Efeitos MCP vêm do manifest assinado: reads conhecidos pulam o mutation gate; writes/destructive
continuam sujeitos aos gates; efeito desconhecido falha fechado.

## Erros comuns e diagnóstico

- `HOST_UNKNOWN`: use o fallback MCP/CLI ou publique um adapter isolado.
- `HOST_VERSION_UNPROVEN`: atualize o manifest ou opere em modo degradado.
- `HOST_CAPABILITY_UNAVAILABLE`: remova a dependência ou obtenha waiver humano explícito.
- `HOST_ENVELOPE_UNKNOWN`: versão/evento não reconhecido nunca vira evidência verificada.
- Tool com nome parecido não define efeito; confira o catálogo assinado com `wendkeep mcp inspect`.

## Próximos passos

Veja [MCP nativo](mcp.md), [sessões e importação](sessions-and-import.md),
[changes e verificação](changes-and-verification.md) e [Observer](observer.md).
