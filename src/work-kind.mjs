export const WORK_KINDS = Object.freeze([
  'inspection',
  'maintenance',
  'implementation',
  'delivery',
  'recovery',
]);

export const CONTRACT_IMPACTS = Object.freeze(['none', 'internal', 'public']);

function normalize(value, values, code, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (values.includes(normalized)) return normalized;
  const error = new Error(`${label} inválido: ${String(value || '(vazio)')}. Use ${values.join(', ')}.`);
  error.code = code;
  throw error;
}

export function normalizeWorkKind(value) {
  return normalize(value, WORK_KINDS, 'WENDKEEP_WORK_KIND_INVALID', 'work kind');
}

export function normalizeContractImpact(value) {
  return normalize(value, CONTRACT_IMPACTS, 'WENDKEEP_CONTRACT_IMPACT_INVALID', 'contract impact');
}

export function createWorkRoute({
  workKind,
  profile = '',
  contractImpact = 'none',
  operationRisk = [],
  sourceChange = '',
  sourceCommit = '',
} = {}) {
  const kind = normalizeWorkKind(workKind);
  const impact = normalizeContractImpact(contractImpact);
  const risks = [...new Set((Array.isArray(operationRisk) ? operationRisk : [operationRisk])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  if (kind === 'delivery' && impact !== 'none') {
    const error = new Error('delivery só aceita contract_impact none; alteração de contrato exige implementation.');
    error.code = 'WENDKEEP_DELIVERY_CONTRACT_IMPACT';
    throw error;
  }
  return {
    work_kind: kind,
    profile: String(profile || (kind === 'delivery' ? 'ASSURE' : '')).trim().toUpperCase(),
    contract_impact: impact,
    operation_risk: risks,
    ...(sourceChange ? { source_change: String(sourceChange) } : {}),
    ...(sourceCommit ? { source_commit: String(sourceCommit) } : {}),
  };
}

export function classifyWorkRequest(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (/acompanhar|acompanhe|status|actions|diff|inspecion/.test(text)) return 'inspection';
  if (/token\s+(?:expir|venc)|credencial.*(?:expir|venc)/.test(text)) return 'recovery';
  if (/corrig|corrij|alter|implementar|package\.json.*errad|workflow.*(?:errad|falh)/.test(text)) return 'implementation';
  if (/merge|push|public|publish|tag|release/.test(text)) return 'delivery';
  if (/texto|formata|manuten/.test(text)) return 'maintenance';
  return 'implementation';
}
