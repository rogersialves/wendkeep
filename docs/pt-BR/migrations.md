# Migrations do plano de controle

O subpath `wendkeep/migrations` oferece o harness comum para upgrades N-2 e N-1 de Vault, ledger,
active contexts, Observer e portable state. O registry declara passos sequenciais e idempotentes;
o runner não substitui as validações de autoridade dos stores.

## Contrato durável

O fluxo é `plan → precondition → backup → journal → write → checksum → receipt`. Cada passo grava
hashes de entrada e saída antes de avançar. Authority, memory, contracts e evidence são preservados
como dados canônicos; a migration só acrescenta a evolução versionada.

Um crash pós-write é retomado apenas quando o checksum coincide com o journal. Divergência falha
fechado sem overwrite. O backup original é verificável e o rollback é determinístico somente se o
estado corrente ainda coincide com o receipt final. Journal truncado exige `repair` explícito; o
repair arquiva o journal corrompido, rederiva o plano do estado íntegro e nunca inventa autoridade.

O receipt público segue `schema/migration-receipt-v1.schema.json`. Versão futura, recurso errado,
autoridade ausente, checksum divergente ou backup adulterado bloqueiam a operação.

Os composition roots reais invocam o plano antes de mutações/leitura incompatíveis: registry de
active contexts, import/diff do portable state, lifecycle de memória do Vault, receipt ledger JSONL
e migration SQL do Observer. O ledger v1 preserva os bytes históricos sob prefixo legado e publica
checkpoint v2; nenhum desses fluxos depende apenas das fixtures N-2/N-1. O journal fechado segue
`schema/migration-journal-v1.schema.json`.

`src/control-plane-migrations.mjs` é o composition root fino: ele registra adapters no harness de
`wendkeep/migrations`, mas delega parsing e escrita às autoridades produtivas. Vault é reaberto pelo
validador do bundle de memória, o ledger pelo verificador de chain/checkpoint e o Observer pelo
migrator SQLite. No Observer, replay é idempotente e rollback/repair usam o backup estrutural real.
O mesmo registry enumera exatamente os cinco recursos; active contexts persiste pelo store de
sessões e portable state reabre pelo upgrader canônico, sem chamadas laterais fora do harness.
