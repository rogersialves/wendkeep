# wend — Pacote de Documentação do Projeto

> **wend**: plugin/SaaS que captura automaticamente sessões de agentes de código (Claude Code à frente) como Markdown local, indexadas semanticamente e renderizadas no grafo de conhecimento do Obsidian. Modelo open-core: núcleo local grátis, cloud pago.

## O que é este pacote

A fonte-da-verdade do projeto. Serve para você não re-decidir as mesmas coisas a cada sessão e para qualquer colaborador futuro entender **o que foi decidido e por quê**. Mantê-lo atualizado é barato; reconstruir o raciocínio do zero, caro.

## Índice dos arquivos

| Arquivo | Conteúdo |
|---|---|
| `01-pesquisa-ferramentas-pkm.md` | Estudo: Obsidian vs. ferramentas de PKM "AI-native" para o caso de uso (Markdown local + captura de sessões de LLM). Veredito e fontes. |
| `02-pesquisa-nome-disponibilidade.md` | Estudo de nome: por que "wend", todas as rodadas de verificação de disponibilidade (npm/PyPI/Obsidian/GitHub) e o significado da palavra. |
| `03-analise-concorrentes.md` | ThreadKeeper, Threadlog, Threadbase e o cenário de memória de sessão de IA — como mapa de requisitos, não gabarito de cópia. |
| `04-escopo-fronteira-opencore.md` | Escopo executivo e a regra de fronteira "uma máquina vs. atravessa máquinas/pessoas". |
| `05-roadmap.md` | Roadmap detalhado, destravado por evidência (gates), não por datas. |
| `06-decisoes-justificativas.md` | Log de decisões (estilo ADR): cada decisão, alternativas consideradas, justificativa e risco. |
| `07-features-fora-de-escopo.md` | Features e nomes descartados/adiados — e o motivo de cada um. |
| `08-estado-implementacao.md` | **Reconciliação docs × código:** o núcleo do wend já existe e roda como os hooks de sessão do NutriGym-Vision. Inventário, lacunas reais e inversões estratégicas que isso força. |

## Status atual (v0.2 — pós-reconciliação 2026-06-29)

- **Nome decidido:** wend (npm e id de plugin Obsidian livres; PyPI usa `wend-sessions`).
- **Modelo:** open-core (local grátis / cloud pago).
- **Fronteira:** uma máquina = grátis; atravessa máquinas ou pessoas = pago.
- **Núcleo já construído e em produção:** captura de sessão → Markdown no Obsidian, custo/tokens (Fase 1), extração de decisões/bugs/aprendizados e memória curada **já existem e rodam diariamente** — como os hooks do **NutriGym-Vision** (`.agent/hooks/`), não como produto standalone. Inventário em `08`.
- **Lacunas reais:** busca semântica por embeddings (hoje é *keyword scoring*) e sync E2E (zero código). Ver `08`.
- **Aposta do MVP pago:** documentada como sync; a evidência do código sugere **inverter para custo/tokens** (construído e defensável). Ver `D8` revisada em `06`.
- **Público inicial:** dev solo local-first; usuário-zero (você) já validado por uso real — mas n=1 não é mercado.
- **Próximo passo real:** não é "construir a Fase 0" (feita). É **decidir produtizar ou não** e validar **n=2** — extrair o núcleo num repo standalone decopulado e pôr na frente de outros devs. Distribuição, não mais estratégia nem reconstrução.

## Aviso

Documentar não é enviar. **Atualização (2026-06-29):** o código-núcleo já roda para o usuário-zero (ver `08`). O congelamento de estratégia continua valendo — mas o progresso agora não é reabrir estratégia nem reconstruir o que existe; é validar **n=2** e, se confirmar, produtizar.
