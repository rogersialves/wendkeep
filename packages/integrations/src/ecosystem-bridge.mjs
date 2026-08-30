import { resolve } from 'node:path';

import { assessBridgeAdapter, inspectBridgeAdapterRoot, readBridgeConfig } from './bridge-config.mjs';
import { validateBridgeOwnership } from './bridge-contract.mjs';
import { detectSpecKit } from './spec-kit-adapter.mjs';

export function inspectEcosystemBridges({ projectRoot, configPath = '', fs = null } = {}) {
  try {
    const root = resolve(projectRoot || process.cwd());
    const loaded = readBridgeConfig(root, configPath, { fs });
    const spec = detectSpecKit({ projectRoot: root, config: loaded.config, fs });
    const specOwnership = validateBridgeOwnership({
      adapter: 'spec-kit', claims: loaded.config.adapters['spec-kit'].ownership_claims || [],
    });
    const superConfig = loaded.config.adapters.superpowers;
    const superRoot = inspectBridgeAdapterRoot(root, superConfig.root || '.superpowers', { adapter: 'superpowers', fs });
    const superAssessment = !superRoot.valid
      ? {
        available: false,
        diagnostics: superRoot.diagnostics,
      }
      : assessBridgeAdapter('superpowers', {
        config: loaded.config,
        detectedVersion: superConfig.version || '',
        present: superRoot.present,
      });
    const superOwnership = validateBridgeOwnership({
      adapter: 'superpowers', claims: superConfig.ownership_claims || [],
    });
    const adapters = [
      {
        adapter: 'spec-kit',
        active: spec.assessment.available,
        available: spec.assessment.available,
        version: spec.version,
        diagnostics: [...spec.assessment.diagnostics, ...(loaded.config.adapters['spec-kit'].enabled ? specOwnership.diagnostics : [])],
      },
      {
        adapter: 'superpowers',
        active: superAssessment.available,
        available: superAssessment.available,
        version: superAssessment.version || superConfig.version || '',
        diagnostics: [...superAssessment.diagnostics, ...(superConfig.enabled ? superOwnership.diagnostics : [])],
      },
    ];
    const diagnostics = adapters.flatMap((item) => item.diagnostics);
    return {
      schema_version: 1,
      ok: diagnostics.every((item) => !item.blocking),
      config_path: loaded.path,
      config_exists: loaded.exists,
      adapters,
      diagnostics,
    };
  } catch (error) {
    return {
      schema_version: 1,
      ok: false,
      config_path: '',
      config_exists: false,
      adapters: [],
      diagnostics: error?.diagnostics || [{
        schema_version: 1,
        code: error?.code || 'BRIDGE_CONFIG_INVALID',
        adapter: '',
        blocking: true,
        message: error?.message || String(error),
      }],
    };
  }
}

export function renderEcosystemBridgeLines(result) {
  const lines = [`[bridges] ${result.ok ? 'saudável' : 'bloqueado'} · ${result.adapters.filter((item) => item.active).length} ativo(s)`];
  for (const adapter of result.adapters) {
    lines.push(`  ${adapter.active ? '✓' : '·'} ${adapter.adapter}: ${adapter.active ? `compatível ${adapter.version}` : adapter.diagnostics[0]?.code || 'inativo'}`);
  }
  for (const diagnostic of result.diagnostics.filter((item) => item.blocking)) {
    lines.push(`  ✗ ${diagnostic.code}: ${diagnostic.message}`);
  }
  return lines;
}
