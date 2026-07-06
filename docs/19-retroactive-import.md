# Memória retroativa — `wendkeep import` (design, 0.16.0)

Instala o wendkeep → roda um comando → **todo o histórico de sessões do Claude Code do
projeto vira memória persistente no vault** (notas datadas + custo + subagents), e o
`wendkeep cost` passa a cobrir o passado inteiro.

## Decisões (aprovadas)
- **Fonte v1: Claude só** (`.claude/projects/<slug>/*.jsonl`). Codex = follow-up.
- **Dedup por `session_id`** — só importa transcript cujo id **ainda não é nota** no vault.
- **Organiza nas pastas certas por data** — `02-Sessões/<ano>/<MM-MMM>/DIA <dd>/` da data
  REAL da sessão (não hoje).
- **Cria (write) por padrão** — é aditivo e dedup'd (nunca sobrescreve nota existente).
  `--dry-run` só relata o que criaria. `--limit N`/`--since d` pra fatiar.

## Abordagem: replay do fluxo vivo, offline
A nota importada = **idêntica** à capturada ao vivo, porque reusa o mesmo código:
1. `parseTranscript(txPath)` → tx (turnos, sessionId, timestamps).
2. `now` = timestamp do 1º evento; `summary` = 1º prompt do usuário.
3. `allocateSessionPath(vaultBase, now, summary)` → caminho na pasta datada correta.
4. `buildSessionContent({relPath, now, summary})` → skeleton; escreve.
5. Por turno: `insertIteration(absPath, buildIterationBlock(tx,{turn_id,now:turn.ts}), turn.turnId, tx)`.
6. Finalize: `createLinkedNotes` + `findLinkedDerivedNotes` → `finalizeSessionFile(absPath, tx, created, endedAt)`.
7. Custo/telemetria: `updateSessionUsage` + `upsertSubagentUsage`.
8. `upsertSessionRegistry` (registra pro backfill futuro).

## Módulos
- **Exports mínimos (sem mudar comportamento):** `buildSessionContent` + `allocateSessionPath`
  (session-start); `finalizeSessionFile` + `mergeCreatedNotes` + `findLinkedDerivedNotes`
  (session-stop). Só adicionar `export`.
- **`hooks/import-sessions.mjs` (novo):**
  - `capturedSessionIds(vaultBase)` — Set dos `session_id` já em notas (varre `02-Sessões/**`, lê frontmatter).
  - `discoverTranscripts(projectPath, fromDir)` — lista `.claude/projects/<slug>/*.jsonl`
    (slug auto do projectPath + `--from` override). Cada: {path, sessionId, startDate}.
  - `importSession(vaultBase, txPath)` — o replay (passos 1–8); retorna `{sessionId, rel, turns}`.
  - `runImport(vaultBase, { projectPath, from, since, limit, dryRun })` — descobre, dedup por
    sessionId, importa os novos; retorna relatório `{scanned, imported, skipped, sessions:[]}`.
- **`src/import.mjs`** — `runImportCli(argv)`: resolve vault + project; chama; imprime relatório.
- **`bin`** — comando `import`; `HOOK_FILES += import-sessions.mjs`.

## Slug do `.claude/projects`
`C:\GitHub\NutriGym-Vision` → dir `c--GitHub-NutriGym-Vision` (encoding interno do Claude:
sep e `:` viram `-`). Encoding **best-effort** a partir do projectPath; se a pasta não
existir, exige `--from <dir>` (robusto). Documentar o `--from` como o caminho garantido.

## Segurança
- **Nunca sobrescreve** — dedup por sessionId + `insertIteration`/`buildSessionContent` só
  criam nota nova. Import 2× = idempotente (2ª vez pula tudo).
- **Fail-soft por transcript** — um transcript corrompido é pulado (entra em `report.errors`),
  não derruba o import inteiro.
- Vault é git-versionado (do usuário) → dá pra reverter um import em massa.

## Aceite
1. `capturedSessionIds` lê os ids das notas existentes.
2. `importSession` num transcript sintético → nota datada correta, com iterações + custo + (se houver) subagents.
3. `runImport` dedup: transcript já capturado = skip; novo = import; idempotente em 2ª rodada.
4. `--dry-run` relata sem escrever. `--limit`/`--since` fatiam.
5. Demo real: contar quantas sessões do `.claude/projects/c--GitHub-NutriGym-Vision` seriam
   importadas (dry-run, sem escrever no vault read-only até o usuário rodar `--write`... na
   verdade default é write; então testo em vault temp apontando `--from` pro real).

## Não-objetivos
- Codex (`.codex/**`) — follow-up (parser já lê, mas extração de turno/localização difere).
- Reprocessar notas já existentes — só importa ausentes (dedup).
