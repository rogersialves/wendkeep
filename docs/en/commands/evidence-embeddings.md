# Optional evidence embedding plugin

[Português](../../pt-BR/commands/evidence-embeddings.md)

## Purpose

Define a programmatic boundary for local semantic reranking without adding a model, ML runtime,
vector database, HTTP client, or provider dependency to WendKeep Core.

This surface is **not a CLI command**. It is exported by `wendkeep/vault` for local plugins that are
explicitly supplied by the application's composition root.

## Default state

Embeddings are disabled by default.

```js
const result = await rerankEvidenceCandidatesWithEmbedding(rows, query);
// result.metrics.status === 'disabled'
```

Core does not:

- discover plugins in `node_modules`;
- execute `import()` from Vault configuration;
- download models;
- open network connections;
- persist vectors;
- hand the full corpus to a plugin.

A plugin receives data only when the caller supplies the plugin object and sets `enabled: true`.

## Authority contract

Authority remains ordered as follows:

```text
Vault Markdown/JSONL → incremental index → lexical/FTS candidates → optional reranking
```

The plugin operates only on a bounded prefix of already-filtered candidates. It cannot:

- make its index or cache authoritative;
- silently broaden project, session, change, or logical-path scope;
- hide `authority`, `validity`, or provenance;
- remove unprocessed candidates—they remain at the end in their original order;
- mutate the source objects returned by Core.

## Versioned manifest

Use `buildEvidenceEmbeddingManifest()` to create the manifest and
`createEvidenceEmbeddingPlugin()` to bind it to the `embed` function.

Required fields:

| Field | Rule |
|---|---|
| `schema_version` | `1` |
| `protocol_version` | `1` |
| `plugin_id` | stable local identifier |
| `plugin_version` | adapter version |
| `model_id` | model identifier |
| `model_revision` | immutable revision used by the adapter |
| `model_fingerprint` | `sha256:<64 hex>` for the effective model/configuration |
| `dimensions` | 1 through 65536 |
| `locality` | exactly `local` |
| `transport` | exactly `in-process` |
| `network` | exactly `forbidden` |
| `retention` | exactly `none` |
| `max_batch_size` | 1 through 512 documents |
| `max_input_bytes` | 1 through 4 MiB |
| `integrity` | hash of the canonical manifest payload |

The manifest is declarative. Core cannot sandbox arbitrary JavaScript, so install only trusted local
plugins and review their code. WendKeep prevents automatic loading and validates the contract before
handing over any evidence, but it does not turn third-party code into trusted code.

## Minimal example

```js
import {
  buildEvidenceEmbeddingManifest,
  createEvidenceEmbeddingPlugin,
  rerankEvidenceCandidatesWithEmbedding,
} from 'wendkeep/vault';

const manifest = buildEvidenceEmbeddingManifest({
  plugin_id: 'local.my-embedding',
  plugin_version: '1.0.0',
  model_id: 'local.my-model',
  model_revision: '2026.08.27',
  model_fingerprint: 'sha256:<model-and-configuration-hash>',
  dimensions: 384,
  max_batch_size: 64,
  max_input_bytes: 262144,
});

const plugin = createEvidenceEmbeddingPlugin({
  manifest,
  async embed(request, { signal }) {
    // Local adapter: no network access and no text retention.
    // Return exactly one query vector and one vector for every document.id.
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

The request contains only:

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

`logical_path` is not sent to the plugin. Full provenance remains on the source objects and returns
with the reranked order.

## Plugin response

The response is fail-closed and may contain only:

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

Core rejects:

- dimensions that differ from the manifest;
- `NaN`, infinity, or zero-norm vectors;
- a divergent model fingerprint;
- missing, duplicate, or unknown documents;
- extra envelope fields;
- a vector count that differs from the document count.

The canonical adapter uses cosine similarity. Ties preserve the original order.

## Budgets and fallback

The effective limit is always the lower value between caller and plugin manifest.

- `maxCandidates`: default 128; maximum 512;
- `maxInputBytes`: default 256 KiB; maximum 4 MiB;
- documents that do not fit remain after the reranked prefix;
- Core never sends a partial document;
- a query or first document that cannot fit produces
  `EVIDENCE_EMBEDDING_BUDGET_EXCEEDED`.

With `required: false`—the default—a contract, budget, response, or execution failure returns the
original lexical order and `metrics.status: "fallback"`. With `required: true`, the typed error is
propagated.

Main codes:

- `EVIDENCE_EMBEDDING_PLUGIN_INVALID`;
- `EVIDENCE_EMBEDDING_BUDGET_EXCEEDED`;
- `EVIDENCE_EMBEDDING_RESPONSE_INVALID`;
- `EVIDENCE_EMBEDDING_EXECUTION_FAILED`.

## Safe operation

1. Keep `enabled: false` until the plugin and model hash are verified.
2. Run `verifyEvidenceEmbeddingPlugin(plugin)` before registering the adapter.
3. Pin `plugin_version`, `model_revision`, and `model_fingerprint`; do not use mutable aliases such
   as `latest`.
4. Start with small budgets and compare the result against lexical/FTS recall.
5. Record metrics only—IDs, counts, bytes, and timings—never query, text, or vectors.
6. Treat a fingerprint change as a new generation of any plugin-owned cache.

## Repair

When `metrics.status` is `fallback`:

1. disable the plugin; lexical/FTS recall remains the safe route;
2. validate the manifest and inspect `metrics.reason`;
3. confirm dimensions, fingerprint, and vector count;
4. discard only plugin-owned caches and rebuild them from `EVIDENCE_INDEX.jsonl` authority;
5. never delete or edit `EVIDENCE_INDEX.jsonl`, Markdown, or Core sidecars to repair an embedding
   provider;
6. re-enable with `required: false` and promote to `required: true` only in an environment that
   genuinely requires the provider.

## Deliberate limit

This contract does not install a model or automatically add embeddings to MCP, doctor, or Observer.
It defines the safe, testable boundary for a future sibling adapter. Core remains complete and
functional without any plugin.
