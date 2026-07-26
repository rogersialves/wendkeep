# Instalação e primeiro uso

**PT-BR** · [English](../../en/commands/getting-started.md)

## Objetivo

Instalar o WendKeep, vincular o projeto ao cofre correto e ativar captura, memória e skills sem
sobrescrever configurações existentes.

## Quando usar

Use `wendkeep init` na primeira instalação e `wendkeep sync` depois de atualizar o pacote.

## Quando não usar

Não rode `init --force` para tentar reparar memória ou uma configuração ilegível. Use primeiro
`wendkeep doctor` e o comando de reparo indicado.

## Pré-requisitos

- Node.js 18 ou mais recente.
- Projeto local e permissão de escrita no cofre.
- Claude Code ou Codex; Obsidian é opcional para execução e recomendado para navegar no grafo.

## Sintaxe

```bash
npm install --save-dev wendkeep
npx wendkeep init [opções]
npx wendkeep sync [--project <raiz>] [--vault <cofre>] [--yes]
```

## Opções e códigos de saída

- `--vault <path>` escolhe o cofre; sem ele, o vínculo local `.wendkeep.json` prevalece.
- `--project <path>` aponta a raiz do projeto.
- `--no-mcp`, `--no-colors` e `--no-companions` desativam integrações opcionais.
- `--companions <csv>` habilita companions explicitamente.
- `--yes` aceita defaults não interativos; `--force` atualiza apenas blocos gerenciados.
- Exit `0` indica instalação/sincronização concluída; exit diferente de zero identifica a etapa
  que falhou. `sync` para em `init`, `sync-defs` ou `doctor`, sem esconder o erro.

## Exemplos

Primeira instalação no projeto atual:

```bash
npm install --save-dev wendkeep
npx wendkeep init --no-companions
```

Atualização posterior:

```bash
npm install --save-dev wendkeep@latest
npx wendkeep sync --yes
```

Com pnpm, informe uma versão concreta porque políticas de idade mínima podem manter `latest`
atrasado silenciosamente:

```bash
pnpm add -D wendkeep@0.58.2
pnpm exec wendkeep sync --yes
```

## Resultado esperado

O projeto recebe `.wendkeep.json`, hooks gerenciados de Claude/Codex, definições de skills e um
cofre inicializado. Arquivos preexistentes são mesclados ou preservados; o comando informa o
cofre efetivamente selecionado.

## Erros comuns e diagnóstico

- Cofre errado: confira `.wendkeep.json` e rode `wendkeep doctor --vault <path>`.
- Hooks do Codex não executam: aprove o aviso **Hooks need review** no próximo startup.
- `defs stale`: rode `wendkeep sync-defs --reseed` e reinicie os agentes.
- `sync` para no doctor: leia a seção que falhou; não repita com `--force` sem entender a causa.

## Próximos passos

Veja [manutenção e diagnóstico](maintenance-and-diagnostics.md),
[sessões e importação](sessions-and-import.md) e [memória compartilhada](memory.md).
