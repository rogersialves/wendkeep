# Codex startup com CODEX_THREAD_ID

## Problema

O Codex Desktop fornece a conversa canônica em `CODEX_THREAD_ID`, mas seus hooks
podem iniciar sem `transcript_path`. O roteamento fail-closed de 0.38.1 exige o
transcript para Codex e, por isso, não cria a sessão no vault.

## Solução aprovada

Para provider `codex`, a resolução segue esta ordem:

1. transcript válido, usando `session_meta.payload.session_id`;
2. `CODEX_THREAD_ID` válido quando o transcript ainda não existe;
3. registry previamente reconciliado.

Quando transcript e variável estiverem presentes, os IDs precisam coincidir.
Divergência, UUID inválido ou transcript cross-provider resultam em `deferred`
sem mutação do vault. Claude mantém o fluxo independente introduzido em 0.38.1.

## Persistência

A sessão pode nascer sem `transcript_path`. Assim que um hook posterior apresentar
o transcript compatível, a mesma entrada do registry recebe `transcript_path` e
`transcript_id`; nenhuma nota adicional é criada.

## Aceitação

- Payload Codex sem transcript e com `CODEX_THREAD_ID` cria exatamente uma sessão.
- O transcript posterior é associado à mesma entrada e nota.
- Mismatch entre variável e transcript não grava.
- ID inválido sem transcript não grava.
- O comportamento Claude permanece verde.
- A release preparada é 0.38.3 e não é publicada pelo agente.
