# Commits baseados em evidências

**PT-BR** · [English](../../en/commands/commit.md)

## Objetivo

Produzir a mesma mensagem auditável em Codex, Claude Code ou outro cliente Git, usando somente
entrada tipada, referências públicas e o resumo do index staged. O kernel é determinístico e não
lê o Vault, `.brain`, registros de sessão ou rede.

## Quando usar

Use antes de commits de implementação `feat`, `fix`, `refactor` ou `perf` que precisam registrar
autoridade causal, tarefas, testes, escopo e evidência verificável de forma equivalente entre
harnesses.

## Quando não usar

Não use para inventar prova, publicar conteúdo privado, reescrever histórico ou automatizar push.
Commits `docs`, `test` e `chore` dispensam contexto somente quando todos os arquivos alterados são
objetivamente documentação/testes. Alteração de produto exige o corpo governado mesmo com outro tipo.

## Pré-requisitos

Execute dentro de um repositório Git, com o WendKeep instalado localmente e os arquivos do produto
já selecionados no index staged.

## Sintaxe

```bash
npx --no-install wendkeep commit context --input <json|-> [--json]
npx --no-install wendkeep commit context --clear [--json]
npx --no-install wendkeep commit render --input <json|->
npx --no-install wendkeep commit prepare --message-file <path> [--source <source>]
npx --no-install wendkeep commit validate --message-file <path> [--json]
```

## Opções e códigos de saída

- Exit `0`: contexto escrito/limpo ou mensagem válida.
- Exit `1`: mensagem governada inválida.
- Exit `2`: argumento, JSON, Git, privacidade ou contexto inválido/stale.
- `--consume-context` é reservado ao wrapper `commit-msg`; remove o contexto após validação verde.

## Instalação opt-in

Os hooks Git não são ativados pelo `init` padrão. Para copiar os wrappers portáteis e configurar
`core.hooksPath=.githooks` somente neste repositório:

```bash
npx --no-install wendkeep init --git-commit-hooks --yes
```

Hooks personalizados nunca são sobrescritos silenciosamente. Se o `init` encontrar conflito, ele
preserva o arquivo. Revise-o e, somente se quiser substituí-lo, execute novamente com `--force`; o
arquivo anterior fica em `.bak`.
Um `core.hooksPath` customizado também é conflito: sem `--force` ele permanece intocado.

## Exemplos

### Preparar um commit

Crie um JSON conforme `schema/commit-message-v1.schema.json`. Declare autoridade e referências de
evidência, mas não envie `tasks`, `tests`, `fresh` ou `verified`. O runtime deriva tarefas do
checklist canônico com Task Contracts concluídos. Testes vêm somente de sensores declarados por
`[sensor:<id>]` e executados pelo coletor; `[phase:verify]`
sozinho nunca é resultado. Sensors declarados no Envelope devem corresponder exatamente em IDs,
configuração, comando, severidade e resultado à reexecução canônica; apenas essa reexecução gera a
linha `Tests`. O gate remoto reexecuta o sensor no checkout do SHA correspondente.
Cada referência publicada recebe digest SHA-256 rederivado. ADR/design validam
ID/path/artefato. Tasks com `[req:]` exigem uma referência `spec` versionada e sanitizada que defina
cada requisito. Evidence Envelope, Verdict, receipt e TDD attestation podem participar da validação
local, mas são omitidos da Evidence remota: não há publicação de IDs de worktree/sessão/branch nem
promoção de consistência autocontida para prova. Se uma mensagem os alegar como `fresh`/`verified`,
o range rejeita `WENDKEEP_COMMIT_REMOTE_PROOF_UNAVAILABLE`. Os trailers fixos
`Remote-Proof-Scope: git,authority,tasks,spec,sensors` e `Local-Causal-Proof: unpublished` tornam
essa fronteira explícita. No range, authority/artefatos, task/spec, `Scope` Git e config/sensors são
rederivados do SHA, e apenas a reexecução canônica gera `Tests`. `Co-Authored-By` é
omitido enquanto não houver identidade registrada confiável.

A autoridade normal é a ADR causal:

```json
{ "authority": { "kind": "adr", "adr": "ADR-1234", "ref": "docs/ADR-1234.md", "issue": "#123" } }
```

Somente quando não existe change/ADR causal, o harness nativo pode declarar o fallback abaixo.
`issue` deve ser `#NNN` e `design` precisa estar versionado no mesmo commit sob
`docs/superpowers/specs/` ou `plans/`:

```json
{
  "authority": {
    "kind": "native",
    "issue": "#40",
    "design": "docs/superpowers/specs/design-aprovado.md"
  }
}
```

O runtime confirma perfil efetivo `OFF`, ausência de context/change/lease e ADR causal reais, além
da issue no design. Esse modo gera trailers únicos `Authority: native-no-causal-change`, `Issue` e `Design`. Texto solto,
design não versionado, prova stale/unverified, corpo ou testes ausentes falham fechados.

```bash
git add <arquivos-do-produto>
npx --no-install wendkeep commit context --input commit-input.json
git commit -m "feat(escopo): rascunho"
```

`commit context` calcula o hash SHA-256 do diff staged e guarda o contexto sanitizado em
`.git/wendkeep-commit-input.json`, fora do working tree. `prepare-commit-msg` substitui o rascunho
pela mensagem canônica; `commit-msg` valida e consome o contexto. Se o index mudar, o contexto fica
stale e deve ser recriado.
O `commit-msg` relê o contexto, compara a mensagem inteira e o hash/files staged, e só consome o
contexto após sucesso. `merge`, `squash` e amend limpam contexto incompatível para não contaminar o
commit seguinte. `--message-file` fica contido no repositório ou git-dir.
As tasks derivadas usam a mesma ordenação canônica na mensagem e na revalidação do range; IDs como
`84.2` e `84.10` não dependem da ordem incidental do checklist.

Outros comandos:

```bash
npx --no-install wendkeep commit render --input commit-input.json
npx --no-install wendkeep commit validate --message-file .git/COMMIT_EDITMSG
npx --no-install wendkeep commit context --clear
```

Commits realmente triviais permanecem intactos. Commits de implementação
`feat`, `fix`, `refactor` e `perf` exigem assunto Conventional Commit com ADR ou o fallback nativo
restrito acima, seções Capability, Evidence, Tasks, Tests e Scope, hash staged e trailer
`WendKeep-Commit: v1`. Amend, merge e squash não recebem corpo duplicado ou prova inventada.

## Privacidade e falha segura

- Caminhos absolutos mesmo embutidos, qualquer Vault configurado/default, `.brain`, registros de sessão, PII e segredos são
  rejeitados antes da persistência.
- Evidência `reported`, `legacy-unbound`, `stale` ou `unproven` não pode ser apresentada como prova.
- O contexto contém referências sanitizadas e metadados do diff, nunca o conteúdo privado do Vault.
- `--no-verify` não é um fluxo aceito: o CI valida cada commit novo, inclusive merges e resoluções inéditas.

## Resultado esperado

Uma mensagem determinística, autocontida, sem material privado, com hash do mesmo index que foi
commitado e trailers causais coerentes.

## Erros comuns e diagnóstico

`wendkeep doctor` mostra `[commit-hooks] healthy`, `disabled`, `missing` ou `drift` e permanece
read-only. Para recuperar arquivos ausentes ou divergentes após revisão:

```bash
npx --no-install wendkeep init --git-commit-hooks --force --yes
```

Se um commit for abandonado, limpe apenas o contexto transitório com
`wendkeep commit context --clear`. Nenhum comando reescreve histórico ou faz push automaticamente.

## Próximos passos

Revise a mensagem gerada, faça o commit e deixe o gate de range do PR validar qualquer bypass local.
