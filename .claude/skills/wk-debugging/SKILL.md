---
name: wk-debugging
description: Use quando algo falha, quebra, dá erro ou regride — depuração sistemática por hipótese antes de corrigir.
---
# Depuração sistemática

Use quando algo falha, quebra ou dá resultado errado. Uma hipótese por vez — não saia
mudando coisas no escuro.

## O método

1. **Reproduza** — um caso mínimo e determinístico que dispara a falha. Sem repro
   confiável, você não sabe se corrigiu.
2. **Uma hipótese** — a causa mais provável, específica o suficiente pra testar.
3. **Isole** — confirme ou descarte a hipótese ANTES de corrigir: bisect, log no ponto
   suspeito, comente metade. Prove onde está, não onde você acha que está.
4. **Corrija a raiz** — o defeito real, não o sintoma. Se só some o sintoma, você não
   entendeu a causa.
5. **Verifique** — o repro do passo 1 sumiu E a suíte segue verde. Sem regressão.

## Regras

- Mudou várias coisas de uma vez e "consertou"? Você não sabe o que consertou. Reverta,
  isole uma variável por vez.
- Leia a mensagem de erro inteira e a stack — a linha decisiva costuma estar ali.
- "Não faz sentido" = uma suposição sua está errada. Cheque as suposições, não o improvável.

## Registro no vault

Bug com valor durável vira nota numerada: `wendkeep note new --type bug "resumo"` —
cria `BUG-NNNN-<slug>.md` na pasta do mês de `05-Bugs` (nunca subpasta `DIA N`) e
imprime o path pra você preencher sintoma/causa raiz/correção. Aprendizado extraído do
debug: `wendkeep note new --type learning "lição"` (vira `APR-NNNN-` em `06-Aprendizados`).
