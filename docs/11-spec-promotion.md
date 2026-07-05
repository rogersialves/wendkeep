# Spec promotion — o contrato vivo (design)

Fecha o gap 2: `07-Specs/` deixa de ser inerte. Uma change carrega **deltas** de spec por
capability; no `archive`, os deltas são fundidos no spec vivo. Modelo OpenSpec nativo
(delta-merge + multi-capability), zero dep.

## Conceitos

- **Spec vivo** — `07-Specs/<capability>.md`: os requisitos ATUAIS de uma capability.
  Reflete a verdade corrente; a história fica nos changes arquivados + ADRs.
- **Delta** — o que uma change muda numa capability: requisitos ADICIONADOS, MODIFICADOS
  ou REMOVIDOS. Vive dentro da change em `08-Mudanças/<slug>/specs/<capability>/spec.md`.
- **Promoção** — no `wendkeep change archive`, para cada capability em `specs:` da proposta,
  o delta é aplicado ao spec vivo (cria se não existe).

## Formato — spec vivo (`07-Specs/<capability>.md`)

```markdown
---
type: spec
cssclasses:
  - topic-spec
tags:
  - spec
---
# <capability>

## Requisitos

### Requisito: <nome>
<texto do requisito / cenários>

### Requisito: <outro nome>
<texto>

> Atualizado por [[08-Mudanças/_arquivo/<data>-<slug>/proposta]] em <data>.
```

Cada requisito é um bloco `### Requisito: <nome>` (o nome é a chave de identidade) + corpo
até o próximo `###` (ou o footer `>`).

## Formato — delta (`08-Mudanças/<slug>/specs/<capability>/spec.md`)

```markdown
## ADDED Requirements
### Requisito: <nome novo>
<texto>

## MODIFIED Requirements
### Requisito: <nome existente>
<texto novo, substitui o atual>

## REMOVED Requirements
### Requisito: <nome a remover>
```

Seções ausentes = vazias. Em REMOVED, o corpo é ignorado (só o nome importa).

## Merge (aplicação do delta)

O spec vivo é um mapa `nome → corpo` (ordem de inserção preservada). Aplicar um delta:

- **ADDED / MODIFIED** — `map.set(nome, corpo)` (upsert). ADDED que já existe ou MODIFIED
  que não existe: aplica mesmo assim, mas registra um aviso (`stderr`) — a distinção é
  validação, não bloqueio.
- **REMOVED** — `map.delete(nome)`.

Re-renderiza o spec vivo a partir do mapa + atualiza o footer `>` com o link do change
(caminho ARQUIVADO) + data. Assim o grafo do Obsidian liga capability↔change↔decisão.

## Fluxo no `archive`

`wendkeep change archive <slug>` (após o gate verde):

1. Lê `specs:` da proposta (`08-Mudanças/<slug>/proposta.md`). Vazio → pula promoção
   (comportamento atual: só ADR).
2. Para cada capability: lê `specs/<capability>/spec.md` (delta) da change; aplica ao
   `07-Specs/<capability>.md` (cria se ausente); escreve.
3. Move a change pro `_arquivo` (os deltas viajam junto — trilha de auditoria).
4. Gera o ADR, linkando as capabilities promovidas.

Ordem: promover ANTES de mover (o delta está no dir da change), mas linkar pro caminho
futuro arquivado (como o ADR já faz).

## Módulos

- `hooks/spec-core.mjs` (novo, puro) — `parseRequirements(md)`, `parseDelta(md)`,
  `applyDelta(reqsMap, delta)`, `renderSpec(capability, reqsMap, footer)`,
  `promoteSpecs(vaultBase, changeDir, specs, { changeWikilink, dateStr })`.
- `hooks/change-core.mjs` — `renderChangeScaffold` ganha `specs: []` já presente; adiciona
  um delta de exemplo em `specs/exemplo/spec.md`. `archiveChange` chama `promoteSpecs` e
  retorna as capabilities promovidas.
- `src/taxonomy.mjs` — `HOOK_FILES += 'spec-core.mjs'`.
- `src/init.mjs` — o `07-Specs/README.md` já é semeado (Pilar B); documenta o formato.

## Decisões

- **Delta-merge**, não full-replace (fiel ao OpenSpec; a change expressa intenção).
- **Multi-capability** por change (`specs: [a, b]`); um delta file por capability num subdir.
- **Identidade por nome** do requisito (`### Requisito: <nome>`). Renomear = REMOVED + ADDED.
- **Sem versionamento do spec** no v1 — o vivo é o atual; história nos arquivos. (Futuro:
  changelog por capability.)
- **Não bloqueia** por delta inconsistente (ADDED duplicado / MODIFIED inexistente) — avisa.
