// Memory-compaction protocol for the curated .brain/CORE.md layer.
// Ported from NutriGym-Vision's scripts/validate-brain-core.js to ESM:
//   - cap 25 lines (hard), 22 (soft warning) — 1 durable item per line
//   - 3 required sections
//   - no secrets / no real-provider PII emails
// Plus the seeded skeleton and the protocol reference doc.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const HARD_LIMIT = 25;
const SOFT_LIMIT = 22;

// Bilingual (0.8.0): a CORE is valid when it carries the COMPLETE section set of either
// locale — pt-BR or en. Mixed/partial sets fail (the 3 sections are one contract).
const SECTION_SETS = {
  'pt-BR': [
    { label: 'Preferências do Usuário', regex: /^##\s+Prefer[êe]ncias\s+do\s+Usu[áa]rio\s*$/im },
    { label: 'Padrões Ativos', regex: /^##\s+Padr[õo]es\s+Ativos\s*$/im },
    { label: 'Pendências Abertas', regex: /^##\s+Pend[êe]ncias\s+Abertas\s*$/im },
  ],
  en: [
    { label: 'User Preferences', regex: /^##\s+User\s+Preferences\s*$/im },
    { label: 'Active Patterns', regex: /^##\s+Active\s+Patterns\s*$/im },
    { label: 'Open Items', regex: /^##\s+Open\s+Items\s*$/im },
  ],
};

// Secret patterns reject only "real" values (length floor); abstract mentions like
// `sk_*` / `whsec_*` (trailing asterisk) are allowed.
const SECRET_PATTERNS = [
  { name: 'Stripe secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'Stripe webhook secret', regex: /\bwhsec_[A-Za-z0-9]{20,}\b/ },
  { name: 'JWT token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Bearer token', regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  { name: 'OpenAI API key', regex: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const PII_EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)(?:gmail|hotmail|yahoo|outlook|live|icloud|protonmail)\.[A-Za-z]{2,}\b/i;

// Validate CORE.md content. Returns { ok, errors, warnings, lineCount }.
export function validateCore(content) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const errors = [];

  if (lineCount > HARD_LIMIT) {
    errors.push(`Tamanho ${lineCount} > ${HARD_LIMIT} linhas (hard limit). Curar: remover itens resolvidos (detalhe vive no vault/git).`);
  }
  // Pick the locale set that matches best; require it to be complete.
  const missingBySet = Object.values(SECTION_SETS).map((set) => set.filter(({ regex }) => !regex.test(text)));
  const best = missingBySet.reduce((a, b) => (b.length < a.length ? b : a));
  for (const { label } of best) errors.push(`Seção obrigatória ausente: ## ${label}`);
  for (const { name, regex } of SECRET_PATTERNS) {
    const m = text.match(regex);
    if (m) errors.push(`Possível ${name} detectado: "${m[0].slice(0, 30)}..." — substituir por [REDACTED_SECRET].`);
  }
  const em = text.match(PII_EMAIL_REGEX);
  if (em) errors.push(`Email real detectado: "${em[0]}" — usar user@example.com.`);

  const warnings = [];
  if (lineCount >= SOFT_LIMIT && lineCount <= HARD_LIMIT) {
    warnings.push(`Tamanho ${lineCount}/${HARD_LIMIT} linhas — perto do limite; remover itens resolvidos (≥${SOFT_LIMIT}).`);
  }

  return { ok: errors.length === 0, errors, warnings, lineCount };
}

// The seeded CORE.md (must pass validateCore). Bootstraps the 3 sections so the
// curated hot layer exists with the right shape from day one.
export function renderCoreSkeleton(localeId = 'pt-BR') {
  if (localeId === 'en') {
    return `# CORE — curated memory core (.brain)

> RULE #1 — the project's canonical memory. Hand-curated, 25-line cap (validate: \`wendkeep validate-memory\`). Volatile facts live in DIGEST.md (auto). Depth: /brain-recall <topic>.

## User Preferences
- (durable preferences: language, style, conventions)

## Active Patterns
- (active patterns/architecture another agent must know)

## Open Items
- (open items/decisions — remove when resolved)
`;
  }
  return `# CORE — núcleo curado da memória (.brain)

> REGRA #1 — memória canônica do projeto. Curado à mão, cap 25 linhas (valide: \`wendkeep validate-memory\`). Volátil vive no DIGEST.md (auto). Profundidade: /brain-recall <tópico>.

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

- **QUENTE** (auto-injetada por sessão, budget ~45 linhas):
  - \`.brain/CORE.md\` — curado à mão, **≤25 linhas** (1 item/linha): preferências, padrões, pendências.
  - \`.brain/DIGEST.md\` — auto-gerado (0 token LLM, ≤15 linhas): decisões/sessões/bugs/aprendizados recentes.
- **FRIA** (sob demanda):
  - \`.brain/index.jsonl\` — índice de todas as sessões (1/linha, frontmatter).
  - Vault: \`02-Sessões/**\`, \`04-Decisões/**\`, \`05-Bugs/**\`, \`06-Aprendizados/**\`. Desce via \`/brain-recall <tópico>\`.

## 2. Compactação = regra de geração (sem trabalho manual)

- **DIGEST se auto-compacta**: caps determinísticos (5 decisões, 4 sessões, 2 bugs, 2 aprendizados + \`+N mais\`). O velho cai do quente sozinho e permanece no índice/vault. **NUNCA editar** \`DIGEST.md\`/\`index.jsonl\`.
- **CORE**: quando ≥22 linhas (soft warning), remover itens resolvidos/obsoletos — o detalhe já vive no vault e no histórico do git.

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

Checa: cap 25 (soft 22), 3 seções, sem segredos/PII. Exit 0 = OK, 1 = falha.
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
