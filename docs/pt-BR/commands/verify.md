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
  change inexistente, projeto fora de um repositório Git, `wendkeep.sensors.json` inválido ou
  `WENDKEEP_EVIDENCE_HEAD_CHANGED`.

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

`evidencia.json` segue o [schema público v2](../../../schema/wendkeep.evidence-envelope-v2.schema.json).
O envelope liga `project_id`, `repository_id`, `worktree_id`, `work_session_id`, change e branch a
`base_sha`, `head_sha`, `index_tree_sha`, `worktree_digest`, tarefas, spec e configuração dos
sensores por SHA-256 completo. O digest cobre staged, unstaged, untracked, rename e delete; paths
usam `/`, texto normaliza CRLF/CR para LF e binários preservam bytes. A classificação binária
respeita atributos Git `binary`/`-text` e extensões binárias conhecidas (incluindo `.bin`); arquivos
ignorados não entram.

Cada sensor registra comando sanitizado e seu hash, início/fim, duração, exit code, digest da saída
e tail sanitizado de até 2.000 caracteres. Os artefatos são publicados por temporário path-safe no
mesmo diretório e rename atômico. No deep, `verificacao.json` e `verdict.json` carregam o mesmo
`evidenceEnvelopeId` e `evidenceBinding` completo; o verificador independente deve preservar ambos
no verdict.

Evidência v1 continua legível como `legacy-unbound`, nunca como autoridade equivalente. Rode
`wendkeep change status <slug>` para ver `bound`, `stale` ou `context-mismatch`.

## Erros comuns e diagnóstico

- `no change`: isso é exit 2 e estado ocioso válido; crie/use uma change ou não rode verify.
- Zero/sensores ausentes: confira todas as tags na mesma linha e `sensors list`; várias tags na
  mesma tarefa são válidas e todas entram no gate.
- Gate vermelho: consulte o campo `note` limitado da entrada em `evidencia.json`, corrija a causa
  e repita; não use `archive --force` por conta própria.
- Verdict stale/ausente: regenere `--deep` e peça novo passe independente.
- `WENDKEEP_EVIDENCE_HEAD_CHANGED`: o HEAD mudou enquanto os sensores rodavam; estabilize o
  checkout e repita. A evidência anterior não foi substituída.
- `legacy-unbound`, `stale` ou `context-mismatch`: volte à worktree/sessão correta, recupere o
  contexto se necessário e rode `verify` + `verify --deep` novamente.
- Mutantes sobreviventes: fortaleça o teste discriminante; após três rodadas, revise manualmente.

## Próximos passos

Volte ao [ciclo de changes](changes-and-verification.md) para archive, confira os
[Perfis de Operação](operating-profiles.md) ou consulte
[manutenção](maintenance-and-diagnostics.md) quando não houver change.
