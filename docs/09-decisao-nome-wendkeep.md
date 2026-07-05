# Decisão de nome: `wendkeep`

> Registro para **não re-litigar** a marca. Decisão final tomada em 2026-06-29.

## Decisão

- **Marca / nome do produto:** `wendkeep`
- **Comando CLI:** `wendkeep` (+ alias curto `wk`)
- **npm:** publicar o nome **cru `wendkeep`** (flagship, é o único squatável) e criar a **org `@wendkeep`** para reservar o namespace futuro (`@wendkeep/cli`, `@wendkeep/core`, …)
- **bin:** `bin/wendkeep.mjs`

## Como chegamos aqui (a saga, resumida)

| Tentativa | Por que caiu |
|---|---|
| `wend` (cru) | npm barra com **403 — too similar** (filtro anti-typosquat: perto de send/when/wd/…). Nome de 4 letras não passa. |
| `wendscribe` | Composto livre no npm, mas **diluía a marca** "wend" e não dava namespace para features futuras. |
| `threadkeep` | Org `@threadkeep` chegou a ser criada, depois **descartada** — perdeu a raiz "wend" que tem significado pessoal. |
| **`wendkeep`** ✅ | Junta tudo (ver critérios). |

## Critérios que decidiram

1. **Tema escolhido: jornada / caminho** — a raiz `wend` vem do inglês antigo *wendan* = ir, percorrer, seguir caminho ("wend one's way"). Significado que o dono da marca quer manter.
2. **Canal exigido: npm apenas** (org `@scope` + nome cru livres). Sem exigência de domínio/GitHub nesta fase.
3. **Segurança no filtro npm:** nome **composto ≥ 8 chars** → risco de bloqueio por similaridade ~nulo (ao contrário do `wend` cru).
4. **Valor central no nome:** `keep` = guardar — o produto **guarda a memória das sessões** do agente IA no vault Obsidian.

`wendkeep` foi o único candidato que junta **jornada (`wend`) + guardar (`keep`)**, mantém a raiz, está **livre no npm cru**, e é **suite-friendly** (`@wendkeep/*`).

> Nota: `wendkeep` no PyPI é irrelevante — é registry Python, namespace separado; este pacote é npm.

## Aviso operacional (causa dos reverts)

A pasta `C:\GitHub\Wend` foi **sobrescrita 2×** por re-extração/restore feita em outro chat, apagando o rename. **Regras:**

- `C:\GitHub\Wend` é a **fonte da verdade**. Não re-copiar/re-extrair por cima.
- **Um chat por vez** editando a pasta — dois chats = clobber.
- Snapshot publicável de segurança fica em `scratchpad/wendkeep-0.1.0.BACKUP.tgz`.

## Pendências

- [x] Publicar `wendkeep` cru no npm — **feito 2026-06-29: `wendkeep@0.1.0` live** (`npm view wendkeep`).
- [x] Criar org `@wendkeep` na UI do npm — **feito** (scope `@wendkeep/*` reservado).

### Backlog para o próximo chat (pasta será renomeada `Wend` → `wendkeep`)

Por prioridade sugerida:

1. **GitHub (urgente)** — a pasta **não é repositório git**. Sem histórico, sem backup de fonte (a pasta já foi sobrescrita 2× por re-extração em outro chat). `git init` + `.gitignore` (ignorar `node_modules`, `*.tgz`) + commit inicial + push. **Maior risco aberto.**
2. **Rebrand docs `01`–`08`** — ainda citam `wend`/`threadkeep`. Consistência; **não-publicado** (`files` = só `bin`/`src`/`hooks`/`README.md`), não afeta usuários.
3. **Cabear Codex no `init`** — hoje só cabeia Claude Code; Codex roda nos mesmos scripts mas não é automático.
4. **i18n da taxonomia** — pastas (`02-Sessões`, `04-Decisões`, …) e meses hardcoded em PT-BR nos hooks.
5. **`@wendkeep/cli` (scoped)** — wrapper fino sobre `wendkeep`; sem pressa (org já reserva o namespace).

### Estado publicado (fonte da verdade)

- npm: `wendkeep@0.1.0` (cru, público) + org `@wendkeep`.
- CLI: comando `wendkeep` + alias `wk`; entrypoint `bin/wendkeep.mjs`.
- Backup durável = o próprio npm (`npm pack wendkeep`).
