// Memory-compaction protocol for the curated .brain/CORE.md layer.
// Ported from NutriGym-Vision's scripts/validate-brain-core.js to ESM:
//   - cap 40 lines (hard), 35 (soft warning) — 1 durable item per line
//   - 4 KiB and 320 characters per line
//   - 3 required sections
//   - no secrets / no real-provider PII emails
// Plus the seeded skeleton and the protocol reference doc.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { validateCore } from './core-validator.mjs';
export { CORE_LIMITS, validateCore } from './core-validator.mjs';

// The seeded CORE.md (must pass validateCore). Bootstraps the 3 sections so the
// curated hot layer exists with the right shape from day one.
export function renderCoreSkeleton(localeId = 'pt-BR') {
  if (localeId === 'en') {
    return `# CORE — curated memory core (.brain)

> RULE #1 — the project's canonical memory. Hand-curated, 40-line cap (validate: \`wendkeep validate-memory\`). Volatile facts live in DIGEST.md (auto). Depth: /brain-recall <topic>.

## User Preferences
- (durable preferences: language, style, conventions)

## Active Patterns
- (active patterns/architecture another agent must know)

## Open Items
- (open items/decisions — remove when resolved)
`;
  }
  return `# CORE — núcleo curado da memória (.brain)

> REGRA #1 — memória canônica do projeto. Curado à mão, cap 40 linhas (valide: \`wendkeep validate-memory\`). Volátil vive no DIGEST.md (auto). Profundidade: /brain-recall <tópico>.

## Preferências do Usuário
- (preferências duráveis: idioma, estilo, convenções)

## Padrões Ativos
- (padrões/arquitetura ativos que outro agente precise saber)

## Pendências Abertas
- (pendências/decisões em aberto — remova quando resolvidas)
`;
}

// The compaction-protocol reference doc dropped into the vault.
export function renderCompactionProtocol() {
  return `# Protocolo de Memória — núcleo curado + digest automático (.brain)

> Como cada agente recebe, consulta e persiste memória entre sessões no seu vault.

## 1. Duas camadas

- **QUENTE** (auto-injetada por sessão, com budgets por camada):
  - \`.brain/CORE.md\` — curado à mão, **≤40 linhas** (alerta em 35; 4 KiB; 320 caracteres por linha): preferências, padrões, pendências.
  - \`.brain/DIGEST.md\` — auto-gerado (0 token LLM, ≤15 linhas): decisões/sessões/bugs/aprendizados recentes.
- **FRIA** (sob demanda):
  - \`.brain/index.jsonl\` — índice de todas as sessões (1/linha, frontmatter).
  - Vault: \`02-Sessões/**\`, \`04-Decisões/**\`, \`05-Bugs/**\`, \`06-Aprendizados/**\`. Desce via \`/brain-recall <tópico>\`.

## 2. Compactação = regra de geração (sem trabalho manual)

- **DIGEST se auto-compacta**: caps determinísticos (5 decisões, 4 sessões, 2 bugs, 2 aprendizados + \`+N mais\`). O velho cai do quente sozinho e permanece no índice/vault. **NUNCA editar** \`DIGEST.md\`/\`index.jsonl\`.
- **CORE**: quando ≥35 linhas (soft warning), remover itens resolvidos/obsoletos — o detalhe já vive no vault e no histórico do git.

## 3. O que escrever no CORE

Só estado **durável** que outro agente precise saber — preferência, padrão ativo, pendência aberta. 1 linha por item. Nunca log de sessão (isso é automático no vault).

3 seções fixas (obrigatórias): \`## Preferências do Usuário\`, \`## Padrões Ativos\`, \`## Pendências Abertas\`.

## 4. Sem segredos / PII

\`CORE.md\` nunca contém tokens (\`sk_*\`, \`whsec_*\`, JWT, Bearer), API keys, senhas ou email/telefone real. Use \`[REDACTED_SECRET]\` / \`user@example.com\`.

## 5. Validação

\`\`\`bash
wendkeep validate-memory          # valida <vault>/.brain/CORE.md
wendkeep validate-memory <path>   # valida outro arquivo
\`\`\`

Checa: cap 40 (soft 35), 4 KiB, 320 caracteres por linha, 3 seções, sem segredos/PII. Exit 0 = OK, 1 = falha.
`;
}

// CLI entry for `wendkeep validate-memory [path]`. Resolves the target from an
// explicit path, else <vault>/.brain/CORE.md (--vault or OBSIDIAN_VAULT_PATH).
export function runValidateMemory(argv) {
  let target;
  let vault;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else if (!a.startsWith('-')) target = a;
  }
  if (!target) {
    const base = vault || process.env.OBSIDIAN_VAULT_PATH;
    if (!base) {
      process.stderr.write('wendkeep validate-memory: no target. Pass a path, --vault <path>, or set OBSIDIAN_VAULT_PATH.\n');
      process.exit(2);
    }
    target = join(base, '.brain', 'CORE.md');
  }
  const abs = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(abs)) {
    process.stderr.write(`wendkeep validate-memory: not found: ${abs}\n`);
    process.exit(2);
  }
  const res = validateCore(readFileSync(abs, 'utf8'));
  if (!res.ok) {
    process.stderr.write(`❌  CORE.md viola protocolo (${res.errors.length} erro${res.errors.length > 1 ? 's' : ''}):\n`);
    for (const e of res.errors) process.stderr.write(`   - ${e}\n`);
    process.stderr.write('\nProtocolo: .brain/COMPACTION_PROTOCOL.md\n');
    process.exit(1);
  }
  let msg = `✅  CORE.md OK (${res.lineCount} linhas, 3/3 seções, sem segredos).`;
  for (const w of res.warnings) msg += `\n   ⚠  ${w}`;
  process.stdout.write(`${msg}\n`);
  process.exit(0);
}
