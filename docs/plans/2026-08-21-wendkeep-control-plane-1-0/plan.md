# WendKeep 1.0 — Project Memory Control Plane

**Data:** 2026-08-21  
**Épico:** #69  
**Status:** planejado  
**Estratégia:** PR incremental por capability; nenhum rewrite total

## 1. Visão

O WendKeep deve se tornar o plano de controle local-first de referência para desenvolvimento assistido por agentes. A proposta não é copiar integralmente Spec Kit, Superpowers, Dotcontext ou Medium Brain, mas absorver suas melhores propriedades sob uma arquitetura com uma única autoridade por conceito.

O resultado esperado é um sistema no qual qualquer agente autorizado consiga responder, com evidência:

- qual projeto, repositório, worktree, sessão, change e task estão ativos;
- onde o trabalho realmente parou;
- por que as decisões foram tomadas;
- quais requisitos e critérios de aceite governam a implementação;
- qual código exato foi testado;
- quais gates ainda estão abertos;
- qual operação externa foi autorizada;
- qual entrega foi efetivamente observada;
- como retomar sem reler a conversa anterior.

## 2. Problemas que o programa fecha

### 2.1 Contexto ativo global

O ponteiro global de change/delivery não representa múltiplas worktrees. Uma sessão pode sobrescrever o contexto da outra.

### 2.2 Evidência desligada do código

Tasks e spec possuem fingerprints, mas a prova precisa identificar também repository, worktree, HEAD, index, working tree e configuração de sensores.

### 2.3 Handoff parcialmente heurístico

Resumo textual é útil para humanos, mas não substitui task/handoff contract tipado.

### 2.4 Portabilidade incompleta

O Vault local é rico, porém um clone novo não recebe authored state e active work automaticamente; versionar runtime integral exporia dados privados.

### 2.5 MCP genérico

Ler arquivos do Vault não equivale a operar as invariantes semânticas do WendKeep.

### 2.6 Paridade aparente entre hosts

Claude, Codex, Pi e clientes MCP não oferecem os mesmos eventos. Cobertura ausente deve ser declarada, não inferida.

### 2.7 Observer e escala

O read model precisa de políticas de captura, RBAC, retenção, purge e processamento incremental para uso prolongado/remoto.

## 3. Princípios arquiteturais

1. **Keep Core sempre disponível.** Memória, identidade, sessão, decisões, handoff e persistência não dependem de cloud.
2. **Uma autoridade por conceito.** Autoria, runtime, evidência, autorização, delivery e projeções têm papéis distintos.
3. **Projeções são reconstruíveis.** Observer, índices e dashboards nunca substituem authored state ou event ledger.
4. **Sem last-write-wins silencioso.** Concorrência produz CAS success ou conflito explícito.
5. **Done é derivado.** Checkbox isolada não conclui task com gate aberto.
6. **Prova identifica o objeto provado.** Todo receipt aponta para código, configuração, ator e instante.
7. **Governança proporcional.** Work kind, contract impact, profile e operation risk continuam independentes.
8. **Adapters finos.** Host-specific code não entra no kernel.
9. **Privacidade por padrão.** Metadata e hashes antes de conteúdo completo.
10. **Migração antes de breaking change.** A evolução para 1.0 preserva Vaults e receipts existentes ou oferece repair determinístico.

## 4. Matriz de autoridade

| Conceito | Autoridade | Projeções/consumidores |
|---|---|---|
| Invariantes do projeto | CORE/constituição escolhida | agents, MCP, Observer |
| Spec e requisitos | authored spec/WendKeep ou adapter Spec Kit | task contracts, verify |
| Change | authored change WendKeep | active context, Observer |
| Task | `tarefas.md` + IDs estáveis | task contract derivado |
| Contexto ativo | registry por repository/worktree/session | hooks, CLI, MCP |
| Memória | event ledger + reducer | SHARED_MEMORY, recall |
| Evidência | Evidence Envelope + sensors/verdict | archive, commit, delivery |
| Autorização | profile/lease/delivery capability | adapters operacionais |
| Entrega | efeito observado + receipt | Observer, release report |
| Observabilidade | Observer SQL | dashboard e consultas |

## 5. Ondas de implementação

### Onda 1 — Fundamento multi-worktree

| Issue | Capability | Gate de saída |
|---|---|---|
| #70 | `wendkeep worktree` em `.worktrees/` + VS Code | duas linked worktrees resolvem o mesmo Vault |
| #71 | active context escopado | duas changes concorrentes não se contaminam |
| #72 | cleanup pós-merge | worktree merged some sem perder histórico |

### Onda 2 — Integridade de prova

| Issue | Capability | Gate de saída |
|---|---|---|
| #73 | Evidence Envelope v2 | mudança de código torna prova stale |
| #74 | freshness/provenance gates | archive/delivery recusam prova divergente |
| #75 | task/handoff contracts | E→V depende de gates machine-checkable |
| #76 | attestation TDD | Red e Green pertencem à mesma linha causal |
| #40 | commit universal | mensagem deriva somente de prova fresca |

### Onda 3 — Portabilidade e interfaces

| Issue | Capability | Gate de saída |
|---|---|---|
| #77 | MCP nativo | agentes consultam semântica sem filesystem arbitrário |
| #78 | authored/private + `active-work` | clone limpo sabe o que retomar sem expor runtime |
| #79 | sync CAS/leases | duas máquinas convergem ou explicitam conflito |
| #80 | host capability matrix | coverage/degradação são observáveis |

### Onda 4 — Segurança, escala e ecossistema

| Issue | Capability | Gate de saída |
|---|---|---|
| #81 | Observer security/privacy | captura e acesso obedecem política e scopes |
| #82 | snapshots/index incremental | retomada não reprocessa todo o histórico |
| #83 | bridges Spec Kit/Superpowers | IDs/autoridades permanecem únicos |
| #84 | arquitetura/CI/migrations 1.0 | pacote reproduzível, migrável e protegido |

## 6. Grafo crítico

```text
#70 → #71 → #72
          └→ #73 → #74 → #40
                     └→ #75 → #76
                         ├→ #77
                         └→ #78 → #79
#71 + #75 + #77 → #80
#78 + #79 + #80 → #81
#73 + #78 → #82
#75 + #76 + #77 + #78 → #83
#70–#83 + #40 → #84
```

O grafo representa dependências de contrato. Cada issue continua sendo um PR pequeno e integrável.

## 7. Lifecycle padrão de worktree

### Layout

```text
<repo>/
├── .git/
├── .worktrees/
│   ├── active-context/
│   └── evidence-envelope-v2/
├── .WendKeep-vault/
└── código da worktree principal
```

### Criação manual até #70

```powershell
New-Item -ItemType Directory -Force .worktrees | Out-Null
git switch main
git pull --ff-only
git worktree add ".worktrees/<slug>" -b "wk/<slug>" main
code -n ".worktrees/<slug>"
```

### Criação futura

```powershell
node ./bin/wendkeep.mjs worktree create <slug> --open vscode
```

### Fechamento futuro

```powershell
node ./bin/wendkeep.mjs worktree finish <slug> --pr <numero-ou-url>
```

O fechamento só pode continuar quando:

- PR está realmente merged;
- worktree está limpa;
- não há sessão/delivery/outbox pendente;
- active context foi encerrado;
- receipt foi publicado.

Depois:

- `git worktree remove`;
- branch local removida;
- branch remota apenas com autorização;
- `git worktree prune`;
- memória histórica preservada.

## 8. Fluxo de execução no VS Code

Para cada issue:

1. abrir a issue e copiar slug/dependências;
2. criar a worktree dedicada;
3. abrir nova janela do VS Code;
4. executar `profile status` e routing gate;
5. criar a change no perfil adequado;
6. implementar tarefas TDD pequenas;
7. executar sensores, verify e verdict;
8. archive somente com evidence fresca;
9. push e PR;
10. após merge, cleanup da worktree.

O arquivo `vscode-execution.md` deste diretório contém prompts e comandos prontos.

## 9. Estratégia de rollout

### Compatibilidade

- artefatos existentes são classificados como legacy;
- nenhuma migração inventa identidade causal;
- projeções legadas continuam apenas enquanto inequívocas;
- deprecation é documentada antes de remoção.

### Profiles

- worktree/context/evidence pertencem ao Keep Core ou à infraestrutura comum;
- FLOW não deve receber cerimônia de GOVERN;
- GUIDE usa contratos compactos;
- GOVERN exige prova e review;
- ASSURE acrescenta confirmação/handoff/authorization.

### Releases

Cada capability que altera comportamento observável atualiza:

- README PT/EN;
- guia de comando PT/EN;
- CHANGELOG e versão quando aplicável;
- schemas/migrations;
- tarball smoke;
- receipts de release.

## 10. Métricas de sucesso

- zero contaminação em testes multi-worktree;
- zero archive aceito após alteração de código pós-verify;
- tempo de retomada incremental estável em Vaults grandes;
- 100% das tools MCP com schema e error code documentados;
- capability coverage explícita em todos os hosts suportados;
- nenhum secret em exports/snapshots padrão;
- cleanup idempotente e sem pastas órfãs;
- migrations N-2/N-1 testadas antes de 1.0;
- tarball publicado corresponde ao SHA testado.

## 11. Definition of Done

O programa termina quando:

- contexto ativo é correto por worktree/session;
- evidência prova o código exato;
- task e handoff são contratos estruturados;
- um clone novo pode retomar authored state com segurança;
- MCP nativo opera as invariantes do WendKeep;
- hosts declaram coverage real;
- sync preserva conflitos em vez de escondê-los;
- Observer possui controles de produção;
- ledger/recall escalam incrementalmente;
- bridges externas não criam autoridades concorrentes;
- arquitetura, migrations, CI e supply chain estão prontas para 1.0.
