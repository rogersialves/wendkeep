# Perfis de Operação e FLOW

**PT-BR** · [English](../../en/commands/operating-profiles.md)

## Objetivo

Escolher quanta governança do Wend Runtime uma execução precisa sem desligar o **Keep Core**.
O Keep Core permanece sempre ativo: Vault, sessão, identidade, CORE/SHARED, lessons, custos e
integrações de persistência continuam funcionando em todos os perfis.

## Quando usar

Use `profile` para consultar ou selecionar explicitamente um Perfil de Operação. Use `FLOW` para
manutenção local, reversível e com `spec_impact:none` que caiba num microcontrato Executar →
Validar, sem change.

## Quando não usar

Não selecione `OFF` para tentar contornar uma política: ele entrega a execução ao harness nativo
da LLM e só pode ser escolhido explicitamente. Não finalize em FLOW alterações de contrato
público, segurança/auth, migração/schema, dependências, CI/release, specs ou dos próprios
gates/policies do WendKeep; promova o trabalho para uma change.

## Pré-requisitos

- Projeto inicializado, com `.wendkeep.json` vinculado ao Vault correto.
- Para override de sessão, uma sessão inequívoca no `SESSION_REGISTRY.json`.
- Para FLOW, repositório Git, allowlist de paths, motivo e ao menos um sensor existente em
  `wendkeep.sensors.json`.

## Sintaxe

```bash
npx wendkeep profile status [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile use <perfil> [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep flow start <slug> --allow <path> [--allow <path>...] --sensor <id> [--sensor <id>...] --reason <texto> [--session <id>]
npx wendkeep flow status [<id>]
npx wendkeep flow show <id> [--session <id>]
npx wendkeep flow finish <id> [--session <id>]
npx wendkeep flow promote <id> [--change-slug <slug>] [--session <id>]
```

Todos os subcomandos FLOW também aceitam `--project <path>`, `--vault <path>` e `--json`.
Quando informado, `--session` restringe inclusive consultas e mutações por ID à sessão dona do
FLOW; um ID de outra sessão falha sem mutação.

## Opções e códigos de saída

| Perfil | Rota | Contrato |
|---|---|---|
| `OFF` | harness nativo da LLM | Wend Runtime desligado; Keep Core integral. |
| `FLOW` | E → V | Microcontrato com baseline Git, allowlist, sensores e recibo, sem change. |
| `GUIDE` | P → E → V | Change compacta; política reconhecida para evolução compatível. |
| `GOVERN` | P → R → E → V | Loop a2 atual e fallback conservador. |
| `ASSURE` | P → R → E → V → C | Governança acrescida de confirmação e handoff. |

- A resolução segue override explícito da sessão → `harness.profile` do projeto → `GOVERN`.
  Heurística, tamanho do diff, texto do prompt, variável de ambiente ou erro de leitura nunca
  selecionam `OFF`.
- `profile status` mostra perfil efetivo e origem; `--json` produz saída estruturada. Quando um
  Vault explícito preserva a escolha apesar de binding corrompido, a saída inclui `binding_error`
  e o diagnóstico também vai para stderr.
- `profile use` valida nome e flags estritamente; opção singleton duplicada, incompleta ou com
  valor iniciado por `--` falha antes de I/O. Sem `--session`, altera atomicamente o binding do
  projeto; com `--session`, grava override, origem e timestamp sem trocar a identidade da sessão.
- `.wendkeep.json` continua em `schemaVersion: 1`; o campo aditivo usa, por exemplo,
  `"harness": { "profile": "GOVERN" }`. Binding legado sem o campo também resolve `GOVERN`.
- Binding corrompido nunca equivale a `OFF`. Quando o payload ou a integração legada identifica
  um Vault inequívoco, o Keep Core continua ativo sob `GOVERN` e o hook expõe um diagnóstico;
  guards de mutação falham fechados até o binding ser reparado. Configuração local inválida,
  marcador ausente ou identidade divergente nunca herdam silenciosamente o Vault pai/global.
- `harness.flow.protectedRoots` aceita um array de raízes relativas ao projeto, sem globs ou
  escapes `..`. Cada raiz amplia as superfícies protegidas do FLOW; qualquer alteração sob ela
  exige `flow promote`.

```json
{
  "harness": {
    "profile": "FLOW",
    "flow": {
      "protectedRoots": ["src/internal-api", "infra/releases"]
    }
  }
}
```

- `flow start` captura HEAD, estado Git preexistente, allowlist, sensores, motivo e sessão em
  `.brain/runtime/flows/`; não cria `08-Mudanças`, ADR, verdict, spec ou `CURRENT_CHANGE.md`.
- `flow finish` compara o diff real ao baseline Git e à allowlist, incluindo troca de commit em
  submodule, metadata/config/flags ocultas do Git e superfícies protegidas ignoradas. O projectRoot
  fica congelado e sensores rodam nesse cwd. Uma descoberta física limitada e no-follow mantém
  visíveis aliases protegidos vazios ou ignorados, sem entrar em `.git`, no Vault efetivo ou em
  caches locais; ambiguidade ou estouro de limite bloqueia. Ele rejeita
  symlink/junction/reparse/hardlink no worktree e nos destinos do Vault, revalida antes/depois dos
  sensores e recaptura o snapshot imediatamente antes do recibo, bloqueando qualquer sensor que
  modifique o repositório. Recibo terminal e iteração
  idempotente na sessão só contam como sucesso juntos;
  uma projeção temporariamente ocupada retorna exit `1` e pode ser repetida com segurança.
- `flow promote` cria uma change normal preservando sessão, motivo, paths, sensores e evidência.
  Lock cross-process owner+lease por slug, reserva e estado durável `promoting` elegem um único
  dono; contrato, reserva, attempts, recibo e origem permanecem semanticamente vinculados. O
  perdedor permanece ativo e pode repetir com `--change-slug`. Retries retomam idempotentemente a
  mesma promoção em vez de criar outra change. Não existe `--force` no FLOW.
- Exit `0` indica consulta ou transição concluída; exit `1` indica política/sensor vermelho; exit
  `2` indica perfil, sessão, flow ou argumentos inválidos, sem mutação parcial.

## Exemplos

Consultar o padrão efetivo e aplicar override somente à sessão atual:

```bash
npx wendkeep profile status
npx wendkeep profile use OFF --session 019abc-session-id --json
```

Executar uma manutenção FLOW capturando o `flow_id` retornado por `start`:

```powershell
$flow = npx wendkeep flow start corrige-copy --allow README.md --sensor docs-bilingual --reason "Corrige texto sem alterar contrato" --json | ConvertFrom-Json
$flowId = $flow.contract.flow_id
npx wendkeep flow status $flowId
```

Se o trabalho permanecer local e dentro do microcontrato, finalize com o ID retornado:

```powershell
npx wendkeep flow finish $flowId
```

Se o escopo crescer antes do `finish`, promova em vez de finalizar:

```powershell
npx wendkeep flow promote $flowId
```

Se outra sessão já reivindicou o slug original, o FLOW continua ativo e pode ser promovido
novamente com um destino explícito:

```powershell
npx wendkeep flow promote $flowId --change-slug outro-slug
```

## Resultado esperado

Trocar o perfil não cria outra sessão nem interrompe o Vault. Em `OFF`, a memória e as lessons
continuam injetadas e o Stop continua persistindo sessão/memória, mas router, skill gate,
change context/warn/nag/guard e captura de plano ficam inativos. Um FLOW concluído deixa recibo
durável e consultável; um FLOW promovido passa a seguir o lifecycle normal de change.

## Erros comuns e diagnóstico

- Perfil desconhecido: use exatamente `OFF`, `FLOW`, `GUIDE`, `GOVERN` ou `ASSURE`.
- `OFF` apareceu sem escolha explícita: trate como erro; leitura ausente/inválida deve cair em
  `GOVERN`.
- Sessão ausente ou ambígua: confira `session list` e informe `--session <id>` sem tentar de novo
  com um alvo diferente.
- FLOW sem allowlist, motivo ou sensor: complete o microcontrato antes de editar.
- Path fora do escopo, superfície protegida ou sensor vermelho: corrija/abandone o FLOW ou use
  `flow promote`; não há bypass.
- Sensor que alterou o repositório, allowlist atravessando symlink/junction ou superfície sensível
  ignorada: restaure o estado e promova quando a mudança não for estritamente local. Sensores FLOW
  devem ser somente leitura.
- Projeção da sessão `missing`, `invalid-frontmatter` ou `busy`: restaure/desbloqueie a nota e
  repita `flow finish` ou `flow promote`; o marcador idempotente impede duplicação.
- Sujeira anterior apareceu no diff: ela deve coincidir com o fingerprint inicial e nunca pode ser
  atribuída silenciosamente ao FLOW.

## Próximos passos

Leia [changes e verificação](changes-and-verification.md), o guia profundo de
[verify](verify.md) e [sessões e importação](sessions-and-import.md).
