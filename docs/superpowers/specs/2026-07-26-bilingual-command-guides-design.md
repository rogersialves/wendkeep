# Design — guias bilíngues dos comandos WendKeep

**Status:** aprovado em conversa em 2026-07-26  
**Escopo:** exclusivamente o repositório `C:\GitHub\WendKeep`

## Problema

Os READMEs em PT-BR e inglês acumulam instalação, visão de produto, referência de comandos
e procedimentos operacionais extensos. A tabela única não deixa claro quando cada comando
deve ser usado, confunde `verify` com um health check global e torna difícil manter exemplos,
códigos de saída e diagnóstico em paridade entre os idiomas.

## Objetivos

1. Transformar `README.md` e `README.en.md` em vitrines curtas, navegáveis e agrupadas.
2. Documentar todos os comandos públicos em guias detalhados, espelhados em PT-BR e inglês.
3. Dar páginas próprias aos fluxos complexos de verificação, migração de memória e importação
   retroativa.
4. Impedir drift entre idiomas, links quebrados e documentação ausente no pacote npm.
5. Tornar obrigatória a atualização da documentação quando a interface observável mudar.

## Fora do escopo

- Alterar comportamento, flags ou códigos de saída do CLI.
- Traduzir o acervo histórico já existente em `docs/`.
- Criar site, gerador estático ou tradução automática.
- Documentar APIs internas que não fazem parte do CLI público.
- Alterar `AGENTS.md`, vaults ou arquivos de Vendiva, NutriGym-Vision ou qualquer outro projeto
  consumidor do WendKeep.

## Abordagens consideradas

1. **Um arquivo por grupo:** poucos arquivos, mas fluxos complexos continuam longos e difíceis
   de linkar com precisão.
2. **Um arquivo por comando:** navegação precisa, porém dezenas de pares bilíngues e alto custo
   de manutenção.
3. **Híbrida — escolhida:** sete guias temáticos e três páginas profundas para operações que
   exigem contexto, estados e recuperação detalhada.

## Arquitetura de arquivos

Os diretórios de idiomas são espelhados e usam os mesmos slugs para permitir validação
mecânica de paridade:

```text
README.md
README.en.md
docs/
├── pt-BR/commands/
│   ├── getting-started.md
│   ├── changes-and-verification.md
│   ├── memory.md
│   ├── sessions-and-import.md
│   ├── notes-and-knowledge.md
│   ├── costs-and-observability.md
│   ├── maintenance-and-diagnostics.md
│   ├── verify.md
│   ├── memory-migration.md
│   └── retroactive-import.md
└── en/commands/
    └── os mesmos dez arquivos
```

## Responsabilidade de cada guia

| Guia | Superfície pública |
|---|---|
| `getting-started.md` | instalação, `init`, `sync`, opções iniciais e atualização segura |
| `changes-and-verification.md` | `change`, `spec`, `sensors` e visão do ciclo `verify`/archive |
| `memory.md` | `memory status`, `repair`, `promote`, `reject` e `validate-memory` |
| `sessions-and-import.md` | `hook`, `session` e visão geral de `import` |
| `notes-and-knowledge.md` | `dashboard`, `note`, `renumber-*` e `lesson` |
| `costs-and-observability.md` | `cost`, `cost rebuild` e `stats` |
| `maintenance-and-diagnostics.md` | `doctor`, `sync-defs`, `theme sync`, `--version` e `--help` |
| `verify.md` | requisitos de contexto, sensores, `--deep`, códigos de saída e diagnóstico |
| `memory-migration.md` | legado versus v2, dry-run, apply, backup, candidates e recuperação |
| `retroactive-import.md` | fontes Claude/Codex, deduplicação, forks, dry-run e limites de escopo |

## Contrato editorial dos guias

Cada par usa a mesma ordem de seções e cobre o mesmo comportamento:

1. Objetivo.
2. Quando usar e quando não usar.
3. Pré-requisitos.
4. Sintaxe.
5. Opções e códigos de saída.
6. Exemplos executáveis.
7. Resultado esperado.
8. Erros comuns e diagnóstico.
9. Próximos passos e guias relacionados.

A tradução precisa ser semanticamente equivalente, mas não precisa ser linha a linha. Termos
técnicos, comandos e caminhos permanecem literais.

## Tratamento específico de `verify`

O guia individual deve separar explicitamente:

- `exit 0`: sensores exigidos pela change passaram;
- `exit 1`: o gate foi executado e ficou vermelho;
- `exit 2`: contexto ou uso inválido, inclusive ausência de `--change` e de change ativa;
- `verify`/`verify --deep`: provas de uma change, não health check global;
- `doctor`/`memory status --gate`: checks apropriados quando não existe change;
- `--change <slug>` e `change use <slug>`: seleção explícita versus ponteiro ativo.

## READMEs e navegação

Os READMEs preservam proposta de valor, requisitos, instalação e primeiro uso. A tabela longa
de comandos vira uma visão por grupos contendo finalidade, dois ou três comandos representativos
e links para o guia no idioma correspondente. Fluxos complexos recebem links diretos para suas
páginas profundas.

Links dos READMEs para os guias usam URLs absolutas do GitHub, de modo que funcionem tanto no
repositório quanto na página do npm. Os guias usam links relativos para navegar entre páginas e
oferecem um link visível para o par no outro idioma.

## Distribuição npm

`package.json` passa a incluir somente `docs/pt-BR/commands/` e `docs/en/commands/` além dos
arquivos já publicados. O acervo histórico de `docs/` permanece fora do tarball. O teste de
empacotamento prova que os vinte guias e os dois READMEs estão presentes.

Como os READMEs e novos guias alteram o artefato distribuído, a entrega recebe bump patch para
`0.58.2` e uma entrada de documentação no `CHANGELOG.md` conforme a regra de release.

## Regra permanente do repositório

Fora do bloco gerenciado de `AGENTS.md`, será adicionada uma regra exclusiva do WendKeep:

> Toda alteração em comando, flag, código de saída, fluxo, hook ou comportamento observável deve
> atualizar, no mesmo commit, o resumo do README e o par PT-BR/EN correspondente. Nenhum idioma
> pode ficar atrás do outro.

Essa regra não entra nos seeds de skills nem é propagada por `init`, `sync` ou `sync-defs` aos
projetos consumidores.

## Validação automatizada

Um teste dedicado deve:

1. Comparar o conjunto de arquivos em `docs/pt-BR/commands/` e `docs/en/commands/`.
2. Exigir a estrutura mínima do contrato editorial em cada guia.
3. Validar todos os links Markdown locais nos READMEs e nos vinte guias.
4. Garantir que cada README aponte apenas para os guias do próprio idioma e para o alternador
   de idioma correto.
5. Manter um inventário dos comandos públicos e exigir presença em ambos os idiomas.
6. Exigir no `AGENTS.md` a regra de atualização bilíngue fora do bloco gerenciado.

O teste de empacotamento existente será estendido para abrir o tarball e confirmar os guias.
Os sensores normais do projeto continuam responsáveis pela suíte completa e pelo release gate.

## Falhas e manutenção

- Guia ausente em um idioma: teste vermelho com o caminho complementar esperado.
- Link quebrado: teste vermelho com arquivo, alvo e link de origem.
- Comando público sem documentação: teste vermelho nomeando o comando ausente.
- Estrutura divergente: teste vermelho nomeando a seção obrigatória ausente.
- Guia ausente no tarball: teste de empacotamento vermelho antes da publicação.

## Critérios de aceite

1. Os READMEs apresentam as funcionalidades por grupos e levam aos guias corretos.
2. Existem dez guias PT-BR e dez guias EN com paridade estrutural e sem links quebrados.
3. `verify` não pode mais ser interpretado como health check pós-instalação.
4. Todos os comandos públicos atuais aparecem nos dois idiomas.
5. `AGENTS.md` obriga manutenção bilíngue apenas neste repositório.
6. O tarball `0.58.2` contém os READMEs e os vinte guias.
7. Testes focados, suíte, `wendkeep verify` e `verify --deep` ficam verdes antes do archive.
