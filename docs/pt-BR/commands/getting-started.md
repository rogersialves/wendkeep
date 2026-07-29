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
npx wendkeep sync [--project <raiz>] [--vault <cofre>] [--profile <perfil>] [--yes]
```

## Opções e códigos de saída

- `--vault <path>` escolhe o cofre; sem ele, o vínculo local `.wendkeep.json` prevalece.
- `--project <path>` aponta a raiz do projeto.
- `--profile <OFF|FLOW|GUIDE|GOVERN|ASSURE>` seleciona o Perfil de Operação; instalação nova usa
  `GOVERN`, re-init/sync sem a flag preserva a escolha existente e `OFF` nunca é inferido.
- `--no-mcp`, `--no-colors` e `--no-companions` desativam integrações opcionais.
- `--companions <csv>` habilita companions explicitamente.
- `--yes` aceita defaults não interativos; `--force` atualiza apenas blocos gerenciados.
- Exit `0` indica instalação/sincronização concluída; exit diferente de zero identifica a etapa
  que falhou. `sync` para em `init`, `sync-defs` ou `doctor`, sem esconder o erro.
- `sync` não pré-resolve o Vault antes de `init`: um vínculo inválido falha fechado nessa primeira
  etapa, e apenas um vínculo validado segue para `sync-defs` e `doctor`; nunca há fallback global.

## Exemplos

Primeira instalação no projeto atual:

```bash
npm install --save-dev wendkeep
npx wendkeep init --profile GOVERN --no-companions
```

Atualização posterior:

```bash
npm install --save-dev wendkeep@latest
npx wendkeep sync --yes
```

Com pnpm, informe uma versão concreta porque políticas de idade mínima podem manter `latest`
atrasado silenciosamente:

```bash
pnpm add -D wendkeep@X.Y.Z --config.minimumReleaseAge=0
pnpm exec wendkeep sync --yes
```

## Resultado esperado

O projeto recebe `.wendkeep.json`, hooks gerenciados de Claude/Codex, definições de skills e um
cofre inicializado. Arquivos preexistentes são mesclados ou preservados; o comando informa o
cofre efetivamente selecionado.

Quando MCP está habilitado, o `init` preserva propriedades e servidores existentes em `.mcp.json`
e adiciona `wendkeep-vault`. Se o JSON existente for inválido, o arquivo original permanece byte
a byte intacto e a proposta reconciliada é gravada em `.mcp.json.new`. Desde a versão 0.65, essa
composição pertence ao kernel MCP privado, sem alterar comandos, flags ou a superfície npm pública.

## Erros comuns e diagnóstico

- Cofre errado: confira `.wendkeep.json` e rode `wendkeep doctor --vault <path>`.
- Hooks do Codex não executam: aprove o aviso **Hooks need review** no próximo startup.
- `defs stale`: rode `wendkeep sync-defs --reseed` e reinicie os agentes.
- `sync` para no doctor: leia a seção que falhou; não repita com `--force` sem entender a causa.

## Próximos passos

Veja [manutenção e diagnóstico](maintenance-and-diagnostics.md),
[sessões e importação](sessions-and-import.md) e [memória compartilhada](memory.md).
