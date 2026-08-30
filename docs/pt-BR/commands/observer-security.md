# Segurança do Observer

**PT-BR** · [English](../../en/commands/observer-security.md)

## Objetivo

O Observer é um read model local ou de equipe, nunca uma nova autoridade sobre Vault, spec, memória
ou sync. O modelo de ameaça considera host remoto comprometido, token roubado, operador curioso,
banco/outbox copiados, payload adversarial e purge interrompido. Host/Origin continuam validados;
mutações e leituras sensíveis falham fechadas, inclusive no loopback.

| Classe | Padrão | Risco principal |
|---|---|---|
| documento | `metadata` | memória/decisões integrais |
| transcript | `metadata` | conversa e ferramentas |
| prompt/resposta | `redacted` | PII e segredos |
| uso | `aggregate` | custo e identidade operacional |
| audit/receipt | metadados mínimos | apagar a própria prova |

A policy v1 restringe por classe, `project_id`, glob de path e `entity_type`. Regras mais tardias
vencem apenas no projeto correspondente. Redaction cobre Bearer, credenciais em URL/connection
string, access keys, e-mail, telefone e regexes configuráveis seguras. O schema é
`schema/observer-policy-v1.schema.json`.
Em `transcript_capture: messages`, arrays, JSONL e o envelope canônico `{messages:[...]}` preservam
somente mensagens `user|assistant|system` com `role`/`content` string após redaction; campos extras,
tools e entradas malformadas são descartados ou falham fechados.
A policy explícita é a única autoridade de captura do publisher; `WENDKEEP_OBSERVER_CAPTURE_LEVEL`
é apenas compatibilidade traduzida para policy quando nenhum arquivo de policy foi fornecido e
nunca eleva nem suprime `none|metadata|messages|full` ou documentos `selected` explícitos.
Nos upserts de documento/transcript, `content_hash` sempre representa o conteúdo final após captura
e redaction; captura metadata/selected usa o SHA-256 do conteúdo vazio. Exclusões de documento
continuam efetivas mesmo com captura `none`, preservam path/revision/operação e nunca transportam
conteúdo ou hash obsoleto.
A redaction nunca reescreve campos validados de identidade estrutural, como IDs de projeto/evento/
entidade, paths lógicos, revisions ou operações. A privacidade do path é aplicada de modo fail-closed
pelas regras de captura por projeto/path, não pela renomeação da chave de storage por uma regra de
redaction de conteúdo.
O contrato estrutural por evento também preserva aliases snake/camel aceitos, chaves de documento/
sessão/agente/call/transcript/rollup, timestamps, roles, status, coverage, dimensões de modelo/preço,
workflow e proveniência de source. `title`, `summary`, `agent_name`, conteúdo, prompt/resposta e
metadata continuam como campos de display/conteúdo sujeitos a redaction.
Na publicação incremental, timestamps de turn ausentes ou vazios herdam o instante canônico do
lote, epoch numérico em milissegundos é normalizado para ISO 8601 e valor não vazio inválido falha
fechado antes da policy/store; evento e payload usam o mesmo instante.

## Quando usar

Use ao habilitar o Observer para dados reais, cadastrar ou revogar credenciais, restringir captura,
proteger SQLite/outbox, definir retenção ou eliminar dados com prova verificável.

## Quando não usar

Não use como KMS/secret manager corporativo, para publicar Vault/runtime, para substituir a
autoridade local ou para apagar manualmente tabelas e índices. Captura `full` continua opt-in e
sujeita à policy/redaction.

## Pré-requisitos

Use Node.js 22.13+, mantenha o bind no loopback e injete tokens/chaves somente por variáveis de
ambiente. O token de bootstrap é registrado somente pelo hash, exige projetos explícitos e
expiração finita; não é um admin wildcard fora do registry. Para Docker, defina também
`WENDKEEP_OBSERVER_BOOTSTRAP_PROJECTS`, `WENDKEEP_OBSERVER_BOOTSTRAP_EXPIRES_AT` e uma chave de
32 bytes em hex/base64 em `WENDKEEP_OBSERVER_ENCRYPTION_KEY`. O operador guarda a chave e receipts externos.

## Sintaxe

```bash
npx wendkeep observer serve --token <token> --bootstrap-projects <p1,p2> --bootstrap-expires-at <ISO> [--bootstrap-token-id <id>] [--require-loopback-auth] [--require-encryption]
npx wendkeep observer security token create --project-id <projeto> --role <role> --scopes <scopes> --token-env <env> --expires-at <ISO>
npx wendkeep observer security token rotate --project-id <projeto> --token-id <id> --token-env <env> --expires-at <ISO> [--new-token-id <id>]
npx wendkeep observer security token revoke --project-id <projeto> --token-id <id>
npx wendkeep observer security policy set --project-id <projeto> --file <policy.json>
npx wendkeep observer security policy show --project-id <projeto>
npx wendkeep observer security purge --project-id <projeto> --before <ISO> --classes <classes> [--dry-run]
npx wendkeep observer security retention run --project-id <projeto> [--dry-run] [--operation-id <id>]
```

## Opções e códigos de saída

- `viewer` lê metadata/agregados; `auditor` pode receber scopes sensíveis; `publisher` ingere;
  `admin` administra policy, purge e recovery. Role, scope e projeto precisam autorizar juntos.
- Tokens são persistidos somente como SHA-256; expiração, rotação e revogação valem sem restart.
- Após rotacionar o bootstrap, atualize token e token ID no ambiente; reiniciar nunca reativa a
  credencial antiga revogada ou expirada.
- `--token-env` nomeia a variável com o segredo; o comando nunca imprime o valor.
- `--require-loopback-auth` protege toda a API; reads sensíveis exigem token mesmo sem a flag.
- `--require-encryption` falha se a chave externa estiver ausente ou inválida.
- `WENDKEEP_OBSERVER_REQUIRE_ENCRYPTION=1` aplica a mesma falha fechada a `status`, `security`,
  `register`, `publish` e `reconcile`; com chave configurada, todo primeiro upgrade v5 usa apenas
  `.bak.enc` + manifest antes de qualquer leitura/backfill.
- Exit `0` indica operação concluída; exit `1` indica configuração, autorização, policy, chave ou
  operação inválida. O hook mantém exit `0` fail-open para o fluxo local, mas aborta antes de
  persistir conteúdo inseguro.

O audit guarda capability, resultado, rota e horário, nunca Bearer, prompt, resposta ou payload.

## Exemplos

Recovery offline explícito e auditado:

```powershell
$env:OBSERVER_RECOVERY_TOKEN = '<segredo-forte-temporário>'
npx wendkeep observer security token create --data-dir C:\WendKeepObserver `
  --project-id project-a --role admin --scopes '*' --token-env OBSERVER_RECOVERY_TOKEN `
  --expires-at 2026-09-29T12:00:00Z --reason 'offline recovery' --json
npx wendkeep observer security token revoke --data-dir C:\WendKeepObserver `
  --project-id project-a --token-id <id> --reason 'recovery complete' --json
```

Sempre faça dry-run antes do purge. O runner de retenção é explícito/idempotente (CLI ou
`POST /v1/projects/:id/security/retention`), sem timer oculto:

```powershell
npx wendkeep observer security purge --data-dir C:\WendKeepObserver `
  --project-id project-a --before 2026-08-01T00:00:00Z `
  --classes documents,calls,transcripts --dry-run --json
```

```powershell
npx wendkeep observer security retention run --data-dir C:\WendKeepObserver `
  --project-id project-a --operation-id scheduled-2026-08-29 --dry-run --json
```

## Resultado esperado

TTL é independente para documentos, calls e transcripts. Contagens, remoção de projeções/FTS,
eventos e receipt usam a mesma transação; retry é idempotente e dado antigo tardio gera nova prova.

AES-256-GCM usa AAD por projeto/classe/registro/campo e `keyProvider` externo. O backfill v6 remove
plaintext e índices derivados antes de liberar leituras; chave errada falha sem revelar conteúdo.
A migration estrutural `006-observer-security.sql` cria backup, valida checksum, faz rollback e
permite retry. Em modo at-rest obrigatório, o backup é `.bak.enc`, tem manifest/key ID/permissão
restrita e restauração falha com chave errada; nenhum `.bak` plaintext permanece.

O hook aplica policy metadata/redacted por padrão; `WENDKEEP_OBSERVER_POLICY_FILE` seleciona policy
explícita. `WENDKEEP_OBSERVER_OUTBOX_KEY_ENV` nomeia a variável da chave da outbox e
`WENDKEEP_OBSERVER_OUTBOX_KEY_ID` identifica a chave. O Compose exige autenticação e criptografia.
O painel guarda Bearer somente em memória, exporta cópia sanitizada e expõe Segurança. MCP exige
scope para calls/busca integral. Sync leva apenas `policy_ref`, sem duplicar tokens ou autoridade.

## Erros comuns e diagnóstico

- `observer_token_missing|expired|revoked`: crie/rotacione um token escopado ou faça recovery offline.
- `observer_project_forbidden|role_forbidden|scope_forbidden`: confira a interseção projeto/role/scope.
- `observer_encryption_key_unavailable|observer_decryption_failed`: confira key ID e material externo;
  nunca enfraqueça o modo obrigatório.
- `observer_policy_invalid`: valide campos/captures e remova regex inválida ou explosiva.
- Falha de migration v6: preserve `.pre-006-*.bak.enc` e seu manifest, corrija a causa e repita.

## Próximos passos

Leia [Observer local](observer.md), faça um dry-run de retenção, valide token revogado/expirado e
guarde o receipt fora do banco quando precisar de prova externa. Nunca publique banco, backup,
outbox, chave, token ou `/data`.
