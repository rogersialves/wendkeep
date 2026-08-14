# Perfis de Operação e FLOW

**PT-BR** · [English](../../en/commands/operating-profiles.md)

## Objetivo

Escolher quanta governança do Wend Runtime uma execução precisa sem desligar o **Keep Core**.
O Keep Core permanece sempre ativo: Vault, sessão, identidade, CORE/SHARED, lessons, custos e
integrações de persistência continuam funcionando em todos os perfis.

O perfil `OFF` desativa a ativação automática da governança, não a CLI: comandos explícitos como
`profile`, `flow`, `change`, `verify` e `sensors` continuam disponíveis. Invocá-los é um opt-in
deliberado e executa as validações e gates próprios daquele comando.

## Quando usar

Use `profile use` para uma seleção humana persistente e `profile route` para o harness registrar a
rota temporária da implementação atual. Use `FLOW` para manutenção local, reversível e com
`spec_impact:none` que caiba num microcontrato Executar → Validar, sem change.

## Quando não usar

Não selecione `OFF` para tentar contornar uma política: ele entrega a execução ao harness nativo
da LLM e só pode ser escolhido explicitamente. Não finalize em FLOW alterações de contrato
público, segurança/auth, migração/schema, dependências, CI/release, specs ou dos próprios
gates/policies do WendKeep; promova o trabalho para uma change.

## Pré-requisitos

- Projeto inicializado, com `.wendkeep.json` vinculado ao Vault correto.
- Para override ou rota temporária, uma sessão inequívoca no `SESSION_REGISTRY.json`; `route`
  também exige que o prompt atual já tenha fronteira causal registrada.
- Para FLOW, repositório Git, allowlist de paths, motivo e ao menos um sensor existente em
  `wendkeep.sensors.json`.

### Escopo de ferramenta e autorização Git

Em `GOVERN`/`ASSURE`, o `PreToolUse` do Codex e o gate equivalente do Claude validam a lease de
projeto antes de mutações. A lease inclui sessão, `project_id`, raiz do projeto, raiz Git, remoto,
branch/worktree e provider. `commit`, `push`, `pull`, `merge`, `publish` e operações destrutivas são
capacidades independentes, inclusive em comandos compostos; uma autorização não atravessa projetos
nem branches.

Se o host não expuser o diretório efetivo, ou se a sessão estiver em conflito, a mutação é negada
com diagnóstico sanitizado. Somente leitura pode continuar para investigação.

## Sintaxe

```bash
npx wendkeep profile status [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile use <perfil> [--project <path>] [--vault <path>] [--session <id>] [--json]
npx wendkeep profile route <FLOW|GUIDE|GOVERN|ASSURE> --session <id> --reason <texto> [--project <path>] [--vault <path>] [--json]
npx wendkeep flow start <slug> --allow <path> [--allow <path>...] --sensor <id> [--sensor <id>...] --reason <texto> [--session <id>]
npx wendkeep flow status [<id>]
npx wendkeep flow show <id> [--session <id>]
npx wendkeep flow finish <id> [--session <id>]
npx wendkeep flow promote <id> [--change-slug <slug>] [--session <id>]
```

Todos os subcomandos FLOW também aceitam `--project <path>`, `--vault <path>` e `--json`.
Quando informado, `--session` restringe inclusive consultas e mutações por ID à sessão dona do
FLOW; um ID de outra sessão falha sem mutação.

## Ownership e superfície programática

O workspace privado `packages/harness` é o dono canônico da resolução/política dos Perfis de
Operação e da engine de sensores. Consumidores programáticos usam o subpath público do pacote raiz:

```js
import {
  resolveOperatingProfile,
  runSensors,
  evaluateGate,
} from 'wendkeep/harness';
```

`src/operating-profile.mjs` e `hooks/sensors-core.mjs` são somente fachadas de compatibilidade. A
direção de dependências é `adapters (cli/mcp/integrations/pi) -> Harness -> Vault`; o Vault nunca
depende do Harness. Os workspaces continuam privados e não são publicados como pacotes npm
independentes.

## Opções e códigos de saída

| Perfil | Rota | Contrato |
|---|---|---|
| `OFF` | harness nativo da LLM | Governança automática desligada; Keep Core e comandos explícitos disponíveis. |
| `FLOW` | E → V | Microcontrato com baseline Git, allowlist, sensores e recibo, sem change. |
| `GUIDE` | P → E → V | Change compacta; política reconhecida para evolução compatível. |
| `GOVERN` | P → R → E → V | Loop a2 atual e fallback conservador. |
| `ASSURE` | P → R → E → V → C | Governança acrescida de confirmação e handoff. |

### Legenda da rota

As letras são etapas do trabalho, não comandos individuais:

- `P` = **Planejar/Propor** — entender o pedido, delimitar o escopo e registrar a abordagem.
- `R` = **Revisar** — revisar proposta/design antes da execução; é a revisão formal do loop a2.
- `E` = **Executar** — editar os paths e artefatos permitidos.
- `V` = **Validar** — rodar testes, sensores e verificações e registrar evidência.
- `C` = **Confirmar/entregar** — obter confirmação explícita e fazer handoff.

Logo, `P → R → E → V` é “planejar/propor, revisar, executar e validar”. `FLOW` começa no
microcontrato de execução/validação; `OFF` não impõe rota Wend automática e entrega o processo ao
harness nativo da LLM.

- O harness da LLM classifica semanticamente o pedido e registra `profile route`; o Wend Runtime
  não classifica texto, tamanho do diff, heurística ou variável de ambiente. Ele valida e aplica a
  lease determinística.
- Para correção local, reversível e sem contrato/spec, escolha `FLOW`. Para mudança compacta de
  comportamento que precisa de change sem revisão formal, escolha `GUIDE`. Em dúvida, risco,
  segurança, contrato público, dependências, CI/release ou policy, escolha `GOVERN`. Use `ASSURE`
  quando confirmação e handoff forem parte do contrato.
- `OFF` nunca pode ser uma rota adaptativa; somente uma pessoa o persiste explicitamente por
  `profile use OFF`. Uma base `OFF` ainda pode receber uma elevação temporária para rota Wend.

- A resolução segue lease ativa do prompt → override persistente da sessão →
  `harness.profile` do projeto → `GOVERN`. Lease inválida/expirada e erro de leitura nunca
  selecionam `OFF`.
- `profile status` mostra perfil efetivo e origem. Com `--session`, a saída humana acrescenta
  `base=<perfil>/<origem>` e `lease=<estado>`; `--json` produz os mesmos dados estruturados. Quando
  um Vault explícito preserva a escolha apesar de binding corrompido, a saída inclui
  `binding_error` e o diagnóstico também vai para stderr.
- `profile use` valida nome e flags estritamente; opção singleton duplicada, incompleta ou com
  valor iniciado por `--` falha antes de I/O. Sem `--session`, altera atomicamente o binding do
  projeto; com `--session`, grava override, origem e timestamp sem trocar a identidade da sessão.
- `profile route` exige `--session` e `--reason`, aceita somente os quatro perfis adaptativos e
  grava `lease_id`, motivo, turno/sequência e timestamp sem tocar no perfil persistente.
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

### Escopo da escolha

Sem `--session`, `profile use` grava `harness.profile` no `.wendkeep.json` e muda o padrão do
projeto para as conversas/hooks que não tenham override de sessão. Com `--session <id>`, grava o
override somente no `SESSION_REGISTRY.json` daquela sessão e preserva o padrão do projeto. Por
isso, `profile use OFF` sem `--session` não é um teste isolado; se o `.wendkeep.json` for commitado,
essa escolha também será compartilhada com outros checkouts.

`profile route` cria uma lease apenas para a solicitação atual. Um `Stop` aceito a consome por
CAS; se o cleanup não rodar, o próximo `UserPromptSubmit` avança a sequência e a lease deixa de ser
efetiva. Stop bloqueado preserva a lease para o retry do mesmo pedido. Não há TTL de relógio que
interrompa trabalho longo. Sessão ainda sem prompt causal registrado (turno ausente, sequência
zero, mapa causal ausente ou divergente) é rejeitada antes de qualquer mutação. `status --session`
inclui o perfil-base e o estado da lease tanto na saída humana quanto em `--json`; neste, os campos
são `base_profile`, `base_source` e `task_lease.state` (`active`, `consumed`, `expired`, `invalid` ou
`absent`).

```bash
npx wendkeep profile status                       # padrão do projeto
npx wendkeep profile use GUIDE                   # altera o padrão do projeto
npx wendkeep profile use FLOW --session <id>     # altera somente uma sessão
npx wendkeep profile route FLOW --session <id> --reason "ajuste local"  # pedido atual
npx wendkeep profile status --session <id>       # consulta a sessão efetiva
```

## Exemplos

Consultar o padrão efetivo e rotear somente a implementação atual:

```bash
npx wendkeep profile status
npx wendkeep profile route FLOW --session 019abc-session-id --reason "corrige typo local" --json
npx wendkeep profile status --session 019abc-session-id --json
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
change context/warn/nag/guard e captura de plano automáticos ficam inativos. Os comandos explícitos
continuam disponíveis e executam seus próprios contratos. Um FLOW concluído deixa recibo durável e
consultável; um FLOW promovido passa a seguir o lifecycle normal de change.

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
