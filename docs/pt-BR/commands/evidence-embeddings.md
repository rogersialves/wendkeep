# Plugin opcional de embeddings de evidências

[English](../../en/commands/evidence-embeddings.md)

## Objetivo

Definir uma fronteira programática para reranqueamento semântico local sem adicionar modelo,
runtime de ML, vector database, cliente HTTP ou dependência de provider ao Core do WendKeep.

Esta superfície **não é um comando CLI**. Ela é exportada por `wendkeep/vault` para plugins locais
carregados explicitamente pelo composition root da aplicação.

## Quando usar

Use esta API quando um composition root confiável precisar reranquear um conjunto pequeno de
candidatos que o recall lexical/FTS já filtrou, mantendo o modelo e o adapter fora do Core.

Embeddings ficam desligados por padrão.

```js
const result = await rerankEvidenceCandidatesWithEmbedding(rows, query);
// result.metrics.status === 'disabled'
```

O Core:

- não procura plugins em `node_modules`;
- não executa `import()` a partir de configuração do Vault;
- não baixa modelos;
- não abre conexão de rede;
- não persiste vetores;
- não entrega o corpus inteiro ao plugin.

Um plugin só recebe dados quando o chamador fornece o objeto do plugin e define `enabled: true`.

## Quando não usar

Não use o plugin como índice autoritativo, mecanismo de ampliação de escopo, autoload de código ou
substituto para filtros/recall lexical. Também não use provider remoto: o contrato exige execução
local, in-process, sem rede e sem retenção.

### Contrato de autoridade

A ordem de autoridade permanece:

```text
Markdown/JSONL do Vault → índice incremental → candidatos lexical/FTS → reranqueamento opcional
```

O plugin atua somente sobre um prefixo bounded de candidatos já filtrados. Ele não pode:

- tornar seu índice ou cache a autoridade;
- ampliar silenciosamente o escopo de projeto, sessão, change ou logical path;
- ocultar `authority`, `validity` ou proveniência;
- remover candidatos não processados — eles permanecem no final, na ordem original;
- alterar os objetos-fonte retornados pelo Core.

## Pré-requisitos

- plugin local revisado e carregado explicitamente pela aplicação;
- modelo/configuração fixados por fingerprint SHA-256;
- budgets de batch e bytes definidos;
- candidatos já filtrados pelo recall lexical/FTS.

### Manifest versionado

Use `buildEvidenceEmbeddingManifest()` para criar o manifest e
`createEvidenceEmbeddingPlugin()` para vinculá-lo à função `embed`.

Campos obrigatórios:

| Campo | Regra |
|---|---|
| `schema_version` | `1` |
| `protocol_version` | `1` |
| `plugin_id` | identificador estável e local |
| `plugin_version` | versão do adapter |
| `model_id` | identificador do modelo |
| `model_revision` | revisão imutável usada pelo adapter |
| `model_fingerprint` | `sha256:<64 hex>` do modelo/configuração efetiva |
| `dimensions` | 1 a 65536 |
| `locality` | exatamente `local` |
| `transport` | exatamente `in-process` |
| `network` | exatamente `forbidden` |
| `retention` | exatamente `none` |
| `max_batch_size` | 1 a 512 documentos |
| `max_input_bytes` | 1 a 4 MiB |
| `integrity` | hash do payload canônico do manifest |

O manifest é declarativo. JavaScript arbitrário não pode ser sandboxado pelo Core; portanto, instale
somente plugins locais confiáveis e revise seu código. O WendKeep impede carregamento automático e
valida o contrato antes de entregar qualquer evidência, mas não transforma código de terceiros em
código confiável.

## Sintaxe

```text
buildEvidenceEmbeddingManifest(options)
createEvidenceEmbeddingPlugin({ manifest, embed })
verifyEvidenceEmbeddingPlugin(plugin)
rerankEvidenceCandidatesWithEmbedding(rows, query, options)
```

## Exemplos

```js
import {
  buildEvidenceEmbeddingManifest,
  createEvidenceEmbeddingPlugin,
  rerankEvidenceCandidatesWithEmbedding,
} from 'wendkeep/vault';

const manifest = buildEvidenceEmbeddingManifest({
  plugin_id: 'local.minha-embedding',
  plugin_version: '1.0.0',
  model_id: 'local.meu-modelo',
  model_revision: '2026.08.27',
  model_fingerprint: 'sha256:<hash-do-modelo-e-configuracao>',
  dimensions: 384,
  max_batch_size: 64,
  max_input_bytes: 262144,
});

const plugin = createEvidenceEmbeddingPlugin({
  manifest,
  async embed(request, { signal }) {
    // Adapter local: nenhum acesso de rede e nenhuma retenção de texto.
    // Deve devolver exatamente uma query vector e um vector para cada document.id.
    return {
      schema_version: 1,
      model_fingerprint: manifest.model_fingerprint,
      query_vector: await localModel.embed(request.query.text, { signal }),
      document_vectors: await Promise.all(request.documents.map(async (document) => ({
        id: document.id,
        vector: await localModel.embed(document.text, { signal }),
      }))),
    };
  },
});

const reranked = await rerankEvidenceCandidatesWithEmbedding(rows, query, {
  enabled: true,
  plugin,
  maxCandidates: 64,
  maxInputBytes: 262144,
});
```

O request contém somente:

```json
{
  "schema_version": 1,
  "model_fingerprint": "sha256:...",
  "query": { "text": "..." },
  "documents": [
    { "id": "<chunk_id>", "text": "<title + heading + content>" }
  ]
}
```

`logical_path` não é enviado ao plugin. A proveniência completa permanece nos objetos-fonte e volta
com a ordem reranqueada.

## Resultado esperado

A resposta é fail-closed e deve conter apenas:

```json
{
  "schema_version": 1,
  "model_fingerprint": "sha256:...",
  "query_vector": [0.1, 0.2],
  "document_vectors": [
    { "id": "<chunk_id>", "vector": [0.3, 0.4] }
  ]
}
```

O Core rejeita:

- dimensão diferente do manifest;
- `NaN`, infinito ou vetor de norma zero;
- fingerprint de modelo divergente;
- documento ausente, duplicado ou desconhecido;
- campos adicionais no envelope;
- quantidade de vetores diferente da quantidade de documentos.

A similaridade usada pelo adapter canônico é cosseno. Empates preservam a ordem original.

## Opções e códigos de saída

O limite efetivo é sempre o menor entre o chamador e o manifest do plugin.

- `maxCandidates`: padrão 128; máximo 512;
- `maxInputBytes`: padrão 256 KiB; máximo 4 MiB;
- documentos que não couberem permanecem depois do prefixo reranqueado;
- o Core nunca envia parcialmente um documento;
- query ou primeiro documento que não cabem produzem
  `EVIDENCE_EMBEDDING_BUDGET_EXCEEDED`.

Com `required: false` — padrão — erro de contrato, budget, resposta ou execução devolve a ordem
lexical original e `metrics.status: "fallback"`. Com `required: true`, o erro tipado é propagado.

Códigos principais:

- `EVIDENCE_EMBEDDING_PLUGIN_INVALID`;
- `EVIDENCE_EMBEDDING_BUDGET_EXCEEDED`;
- `EVIDENCE_EMBEDDING_RESPONSE_INVALID`;
- `EVIDENCE_EMBEDDING_EXECUTION_FAILED`.

## Operação segura

1. Mantenha `enabled: false` até validar o plugin e o hash do modelo.
2. Execute `verifyEvidenceEmbeddingPlugin(plugin)` antes de registrar o adapter.
3. Fixe `plugin_version`, `model_revision` e `model_fingerprint`; não use alias mutável como
   `latest`.
4. Comece com budgets pequenos e compare a ordem com o recall lexical/FTS.
5. Registre apenas métricas — IDs, contagens, bytes e tempos — nunca query, texto ou vetores.
6. Trate mudança de fingerprint como uma geração nova de qualquer cache pertencente ao plugin.

## Erros comuns e diagnóstico

Quando `metrics.status` for `fallback`:

1. desative o plugin; o recall lexical/FTS continua sendo a rota segura;
2. valide o manifest e confira `metrics.reason`;
3. confirme dimensão, fingerprint e quantidade dos vetores;
4. descarte somente caches pertencentes ao plugin e reconstrua-os pela autoridade
   `EVIDENCE_INDEX.jsonl`;
5. nunca apague ou edite `EVIDENCE_INDEX.jsonl`, Markdown ou sidecars do Core para reparar um
   provider de embeddings;
6. reative com `required: false` e promova para `required: true` apenas em um ambiente que realmente
   exige o provider.

## Próximos passos

Este contrato não instala um modelo nem integra embeddings automaticamente ao MCP, doctor ou
Observer. Ele define a fronteira segura e testável para um adapter irmão futuro. O Core continua
completo e funcional sem qualquer plugin.

Use o guia de [MCP nativo](mcp.md) para a superfície paginada/lexical já exposta e o guia de
[manutenção e diagnóstico](maintenance-and-diagnostics.md) para inspecionar a saúde dos artefatos
derivados sem reconstruí-los.
