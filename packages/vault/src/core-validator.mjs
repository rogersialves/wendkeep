export const CORE_LIMITS = Object.freeze({
  lines: 40,
  warningLines: 35,
  bytes: 4 * 1024,
  lineChars: 320,
});

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

export function validateCore(content) {
  const text = String(content ?? '');
  const lines = text.split('\n');
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const byteCount = Buffer.byteLength(text, 'utf8');
  const errors = [];
  if (lineCount > CORE_LIMITS.lines) {
    errors.push(`Tamanho ${lineCount} > ${CORE_LIMITS.lines} linhas (hard limit). Curar: remover itens resolvidos (detalhe vive no vault/git).`);
  }
  if (byteCount > CORE_LIMITS.bytes) {
    errors.push(`Tamanho ${byteCount} > ${CORE_LIMITS.bytes} bytes (budget do CORE). Curar: manter apenas estado durável.`);
  }
  lines.forEach((line, index) => {
    if (line.length > CORE_LIMITS.lineChars) {
      errors.push(`Linha ${index + 1} tem ${line.length} caracteres; limite ${CORE_LIMITS.lineChars}.`);
    }
  });
  const missingBySet = Object.values(SECTION_SETS).map((set) => set.filter(({ regex }) => !regex.test(text)));
  const best = missingBySet.reduce((a, b) => (b.length < a.length ? b : a));
  for (const { label } of best) errors.push(`Seção obrigatória ausente: ## ${label}`);
  for (const { name, regex } of SECRET_PATTERNS) {
    const match = text.match(regex);
    if (match) errors.push(`Possível ${name} detectado: "${match[0].slice(0, 30)}..." — substituir por [REDACTED_SECRET].`);
  }
  const email = text.match(PII_EMAIL_REGEX);
  if (email) errors.push(`Email real detectado: "${email[0]}" — usar user@example.com.`);
  const warnings = [];
  if (lineCount >= CORE_LIMITS.warningLines && lineCount <= CORE_LIMITS.lines) {
    warnings.push(`Tamanho ${lineCount}/${CORE_LIMITS.lines} linhas — perto do limite; remover itens resolvidos (≥${CORE_LIMITS.warningLines}).`);
  }
  return { ok: errors.length === 0, errors, warnings, lineCount, byteCount };
}
