# Template — plano de tarefas (TDD, bite-sized)

## Impacto em specs
- `spec_impact`: `required` | `none`
- Capability/delta: `specs/<capability>/spec.md` ou justificativa de `none`

## Arquivos
- Criar: `caminho/exato.mjs`
- Modificar: `caminho/existente.mjs:120-140`
- Teste: `tests/exato.test.mjs`

## Tarefa N — <nome>
- **Consome:** <o que usa de tarefas anteriores — assinaturas exatas>
- **Produz:** <o que tarefas seguintes usam — nomes/tipos exatos>

- [ ] N.1 escreva o teste que falha (mostre o código do teste)  `[req:<ID>]`
- [ ] N.2 rode e veja falhar — pelo motivo certo (comando exato + saída esperada)
- [ ] N.3 implementação mínima (mostre o código)  `[sensor:<id>]` se precisa de prova
- [ ] N.4 rode e veja passar
- [ ] N.5 checkpoint: suíte verde · commit

## Regras
Caminhos exatos sempre. Código real em cada passo — nada de "TODO" / "tratar erros
apropriadamente" / "similar à Tarefa N". DRY, YAGNI. Nomes e assinaturas consistentes entre
tarefas (uma função é `x()` em toda parte). Cada tarefa termina num entregável testável sozinho.
