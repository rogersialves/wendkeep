# Política de suporte

O projeto oferece suporte comunitário, local-first e sem SLA. Nunca anexe Vault, `.brain`, runtime,
tokens, transcripts ou paths privados a uma issue; use reproduções sintéticas e sanitizadas.

## Janela

- `0.90`: linha corrente, recebe correções de segurança, integridade, regressão e compatibilidade.
- `0.89`: manutenção anterior, recebe correções críticas quando o backport é seguro.
- `0.88`: última linha de segurança anterior, recebe apenas correções críticas justificadas.
- Linhas mais antigas: atualização recomendada; não há promessa de backport.

O escopo é best effort, sem SLA de resposta ou correção. Vulnerabilidades devem seguir o canal
privado de Security Advisories do GitHub; bugs públicos usam uma reprodução mínima sem dados reais.

## Gates e plataformas

Os checks candidatos obrigatórios são versionados em `.github/required-checks.json`. O script
`node scripts/required-checks.mjs` apenas valida e renderiza o payload; não altera a proteção da
`main`. O mantenedor aplica a configuração remota somente após observar esses nomes verdes.

Veja a [compatibilidade](compatibility.md) e a [arquitetura](architecture.md).
