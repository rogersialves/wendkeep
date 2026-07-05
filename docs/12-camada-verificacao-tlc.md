# Camada de verificação e qualidade — paridade TLC (programa)

> Programa multi-release. NÃO é um plano de implementação — é o mapa estratégico + os
> contratos. Cada wave vira depois seu próprio spec → plano → implementação.

## Por quê

O core do a2 (memória + change lifecycle + spec vivo + gate por sensor) está pronto e
publicado (0.4.0). Mas o **gate é raso**: trava com "sensor deu exit 0" — e teste verde
pode ser vazio, raso, ou não cobrir o spec. Um gate em que não se confia não é framework,
é teatro.

O **TLC Spec-Driven** (`@tech-leads-club/agent-skills`) resolveu exatamente esse eixo —
verificação independente, mutação, adequação de teste, rastreabilidade req→commit — e
benchmarkou (média 0.94, T=0.90). É uma **skill** (disciplina prompt-engineered + poucos
gates mecânicos). A gente já tem as duas camadas que ela usa: **skills (`wk-*`)** e
**gates (sensores)**. Então portar o TLC é, em grande parte, encher nossa camada de skill
+ acrescentar poucas peças mecânicas — sobre o nosso diferencial que o TLC **não** tem:
memória persistente + grafo compartilhado.

**Régua do programa:** cada item ou (a) conserta a integridade do gate, ou (b) fortalece
o substrato memória/grafo. Feature que não faz nenhum dos dois não entra.

## Mapa de features (TLC → wendkeep)

| # | Feature TLC | Casa no wendkeep | Mecanismo | Esforço | Wave |
|---|---|---|---|---|---|
| 1 | Deterministic gate (runner decide) | sensores | **já existe** | ✓ | — |
| 2 | Closure gate (ambiguidade resolvida/assinada) | skill `wk-brainstorming` + seção proposta | disciplina | S | A |
| 3 | Spec-derived assertions | skill `wk-tdd` | disciplina | S | A |
| 4 | Non-shallow litmus | skill `wk-tdd` | disciplina | S | A |
| 5 | Test Adequacy Review (evidência file:line) | skill `wk-tdd` (+ check no verify) | disciplina + código | M | A |
| 6 | Test learning (amostra testes, lê CI/AGENTS) | skill `wk-tdd` (+ scan init) | disciplina | S | A |
| 7 | Independent Verifier (autor≠verificador) | skill `wk-verify` + `verify --deep` | disciplina + orquestração | L | A |
| 8 | Requirement IDs + rastro spec→task→ADR | `spec-core` + `change-core` | código | M | A |
| 9 | Auto-sizing (pula design/tasks trivial) | scaffold `change-core` | código | S | B |
| 10 | Lessons: falha→lição→auto-inject | `.brain` + `brain-inject` | código | M | B |
| 11 | Bounded fix loop (3 iter) | orquestração `verify --deep` | código | M | B |
| 12 | Discrimination sensor (mutação) | novo tipo de sensor | código | **XL** | B |

Wave A = **credibilidade** (torna o gate confiável). Wave B = **enforcement mecânico**
pesado + conforto.

## As duas pedras (constraints honestas)

### Verificador independente agnóstico (7)
Spawn de sub-agente é específico do agente (Agent tool no Claude, Codex spawna do jeito
dele). Então o verificador **não é código de spawn nosso** — é:
- **Skill `wk-verify`** (agnóstica): manda o agente abrir um **passe read-only fresco**
  que re-deriva a cobertura do `07-Specs`, confere as tarefas contra o spec vivo, e grava
  um veredito. Autor≠verificador vira uma instrução de processo, não um fork de OS.
- **`wendkeep verify --deep`** (mecânico, leve): monta o *pacote de verificação* (spec +
  tarefas + diff + evidência) num arquivo que a skill consome, e grava `verdict.json`. No
  Claude, pode disparar o Agent tool; nos outros, a skill guia o passe. O gate do archive
  passa a poder exigir `verdict.ok`.

### Sensor de discriminação / mutação (12) — a mais dura
Mutar é language-specific (JS≠Python≠Go). Zero-dep pra stack arbitrária é grande demais.
Caminho realista, em camadas:
- **`type: mutation` que delega** — o sensor chama a ferramenta de mutação do usuário
  (`stryker`, `mutmut`, `go test`…) se configurada. **Opt-in, não zero-dep puro** — mas
  agnóstico de linguagem e honesto.
- **Mutador nativo mínimo (bônus, só JS)** — flips de operador (`<`↔`<=`, `===`↔`!==`,
  `+`↔`-`), remoção de linha, contra o comando de teste do usuário. Zero-dep, raso, JS-only.
  Prova o conceito sem prometer cobertura total.
- Mutante sobrevivente → **fix task** gerada na change ativa (fecha com o loop 11).

## Contratos do framework (a API pública)

Esta é a virada de "ferramenta" pra "framework": os formatos abaixo viram **contrato
versionado** (`harness contract v1`), documentados como pontos de extensão. Quem estende
não adivinha.

- **Sensor** — `{ id, name, description, severity: 'critical'|'warning', command, type?: 'command'|'mutation'|'verifier' }`. `command` é default (`type: command`).
- **Requirement ID** — no spec vivo: `### Requisito: <CAP>-<n> — <nome>` (ex.: `AUTH-1 — Login`). ID estável = chave de identidade (renomear texto não muda o ID).
- **Task → requisito** — em `tarefas.md`: `- [ ] 2.1 implementa login [req:AUTH-1] [sensor:tests]` (mesmo padrão do `[sensor:]`).
- **Spec delta** — `## ADDED|MODIFIED|REMOVED Requirements` (já em [11](11-spec-promotion.md)).
- **Skill** — `SKILL.md` com frontmatter `name` + `description` (já existe).
- **Veredito** — `verdict.json` na change: `{ ok, checkedAt, coverage: [{req, covered, evidence}], surviving_mutants: [], notes }`.
- **Lesson** — `.brain/lessons/<slug>.md`: `{ trigger, lesson, source_change }`, terso, auto-injetável.

Publicar como `docs/14-harness-contract.md` no fim da Wave A (a referência de extensão).

## Waves (cada uma vira spec + plano próprios)

### Wave A — Credibilidade (alvo 0.5.0)
Torna o gate confiável, quase tudo na camada de skill + poucas peças de código.
- **Skills TLC-grade** (2–7): reescreve `wk-tdd` (spec-derived, non-shallow, adequacy,
  test-learning) e `wk-brainstorming` (closure gate + out-of-scope); nova `wk-verify`
  (verificador read-only fresco).
- **Req-IDs + rastro** (8): IDs no spec vivo, `[req:ID]` nas tarefas, ADR lista os IDs;
  `verify` checa task↔req (toda task tem req, todo req do spec tem task cobrindo).
- **`verify --deep`** (7, mecânico-leve): monta o pacote de verificação + grava
  `verdict.json`; o gate do archive pode exigir `verdict.ok`.
- **Contrato v1** publicado (`docs/13`).

### Wave B — Enforcement + conforto (alvo 0.6.0)
- **Discrimination sensor** (12) — `type: mutation` delegado + mutador JS nativo mínimo.
- **Lessons loop** (10) — falha de verificação → `.brain/lessons` → injeção no próximo change.
- **Bounded fix loop** (11) — mutante/gap vira fix task, re-verifica, teto 3, escala pro usuário.
- **Auto-sizing** (9) — scaffold pula design/specs em change trivial.
- **`doctor` do harness** (dívida anterior) — valida sensors.json, ponteiro, changes órfãs,
  specs sem origem, task sem req, req sem cobertura.

## Não-objetivos (diferencial mantido)
- **Não** copiar o benchmark/marketing do TLC. Nosso norte é o loop + o substrato, não a tabela.
- **Não** abandonar zero-dep no core: mutação real é **opt-in** (delega), nunca dep obrigatória.
- **Não** virar Claude-only pra ganhar o verificador: a resposta agnóstica é skill-driven.
- **Manter e cavar** o que o TLC não tem: captura de sessão, memória CORE/DIGEST, grafo
  Obsidian wikilinkado (plano↔sessão↔spec↔decisão↔lição). É o fosso.

## Perguntas em aberto (resolver no spec de cada wave)
1. **Req-ID**: no heading (`### Requisito: AUTH-1 — …`) ou no frontmatter do requisito? (heading é mais simples de parsear + humano.)
2. **`verify --deep` no agnóstico**: a skill spawna o passe, ou o `verify` só monta o pacote e o gate exige o `verdict.json` que a skill produz? (o segundo é mais robusto.)
3. **Mutação default**: delegar (opt-in) já basta pro 0.6.0, deixando o mutador JS nativo como stretch?
4. **Gate exige verdict?**: `archive` passa a exigir `verdict.ok` sempre, ou só quando a change declara `verify: deep`? (gradual reduz atrito.)

## Estado
Mapa aprovado → próximo passo: brainstorm + spec da **Wave A** (a de maior alavanca).
Nada de código até o spec da Wave A ser revisado.
