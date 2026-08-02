# Verify e verificação independente

**PT-BR** · [English](../../en/commands/verify.md)

## Objetivo

Executar os sensores exigidos pelas tarefas de uma change, persistir evidência fresca e montar o
pacote autocontido usado pelo passe independente `wk-verify`.

## Quando usar

Use depois de implementar as tarefas e novamente sempre que tarefas, specs ou testes mudarem.

## Quando não usar

Não use como health check pós-instalação ou quando não existe change. Nesse caso, rode
`wendkeep doctor` e `wendkeep memory status --gate`. Em `FLOW`, a validação e o recibo pertencem a
`flow finish`; em `OFF`, `verify` continua disponível apenas quando o usuário escolhe executar o
lifecycle manualmente.

## Pré-requisitos

- Change aberta selecionada por `CURRENT_CHANGE.md` ou `--change <slug>`.
- `tarefas.md` sem placeholders, com tags `[req:]` e uma ou mais `[sensor:]` na linha do checkbox;
  todos os IDs distintos de sensor são exigidos uma vez, na ordem declarada.
- Sensores declarados em `wendkeep.sensors.json`.

## Sintaxe

```bash
npx wendkeep verify [--change <slug>] [--project <raiz>] [--vault <cofre>]
npx wendkeep verify --deep [--change <slug>]
npx wendkeep change use <slug>
```

## Opções e códigos de saída

- `--change <slug>` mira uma change sem alterar o ponteiro ativo.
- `change use <slug>` troca o foco persistido para comandos seguintes.
- `--project <raiz>` define onde os sensores executam; `--vault` define onde a prova é gravada e é
  propagado aos sensores como `OBSIDIAN_VAULT_PATH`, inclusive no `memory-health`.
- **Exit 0:** todos os sensores exigidos passaram e a evidência foi gravada.
- **Exit 1:** o gate executou, mas ao menos um sensor crítico ficou vermelho ou um mutante
  sobreviveu.
- **Exit 2:** uso/contexto inválido, como `no change (--change or active)`, vault ausente,
  change inexistente ou `wendkeep.sensors.json` inválido.

`verify --deep` gera `verificacao.json`; ele não substitui o verificador. A skill `wk-verify`
precisa ser executada por autor diferente e grava `verdict.json`.

## Exemplos

Change ativa:

```bash
npx wendkeep verify
npx wendkeep verify --deep
```

Change explícita:

```bash
npx wendkeep verify --change tenant-login
npx wendkeep verify --deep --change tenant-login
```

Projeto sem change aberta:

```bash
npx wendkeep doctor --vault .MeuApp-vault
npx wendkeep memory status --gate --vault .MeuApp-vault
```

## Resultado esperado

`evidencia.json` contém resultados dos sensores e um selo liga a prova ao hash atual de
`tarefas.md`. Quando um sensor fica vermelho, sua entrada recebe somente um diagnóstico local
sanitizado e limitado a 2.000 caracteres; stdout/stderr de sensores verdes não é persistido. No
deep, o pacote contém requisitos, tarefas e evidência suficientes para revisão read-only; o
verdict cobre cada `[req:]` antes do archive.

## Erros comuns e diagnóstico

- `no change`: isso é exit 2 e estado ocioso válido; crie/use uma change ou não rode verify.
- Zero/sensores ausentes: confira todas as tags na mesma linha e `sensors list`; várias tags na
  mesma tarefa são válidas e todas entram no gate.
- Gate vermelho: consulte o campo `note` limitado da entrada em `evidencia.json`, corrija a causa
  e repita; não use `archive --force` por conta própria.
- Verdict stale/ausente: regenere `--deep` e peça novo passe independente.
- Mutantes sobreviventes: fortaleça o teste discriminante; após três rodadas, revise manualmente.

## Próximos passos

Volte ao [ciclo de changes](changes-and-verification.md) para archive, confira os
[Perfis de Operação](operating-profiles.md) ou consulte
[manutenção](maintenance-and-diagnostics.md) quando não houver change.
