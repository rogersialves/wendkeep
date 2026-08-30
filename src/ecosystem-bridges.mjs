import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import * as bridgeFs from 'node:fs';
import { resolve } from 'node:path';

import {
  importSpecKitProjection,
  buildSpecKitStatusProjection,
  ingestSuperpowersArtifacts,
  inspectEcosystemBridges,
  inspectBridgeAdapterRoot,
  readBridgeConfig,
  verifyExternalArtifact,
  isProjectContainedPath,
  sealBridgeProjection,
  bridgeDiagnostic,
} from '../packages/integrations/src/index.mjs';
import { buildCanonicalExternalTaskDispatch } from './task.mjs';
import { resolveProjectVault } from './project-vault.mjs';
import { readSpecKitBaseline, writeSpecKitBaseline } from './ecosystem-bridge-baseline.mjs';
import { deriveCanonicalArtifactProof } from './ecosystem-bridge-proof.mjs';

export const BRIDGE_HELP = `wendkeep bridge <status|import-spec-kit|export-status|dispatch-superpowers|verify-artifacts>

  --project <path>          consumer project (default: current directory)
  --config <path>           config path (default: .wendkeep/ecosystem-bridges.json)
  --task-id <id>            canonical WendKeep task selected from the active context
  --task-contract <path>    optional submitted copy; rejected when it differs from canonical state
  --spec-projection <path>  optional read-only Spec Kit projection
  --change <slug>           causal change holding the canonical Spec Kit baseline/evidence
  --accept-baseline         anchor the first green Spec Kit projection in the bound Vault
  --input <path>            external artifacts JSON for verify-artifacts
  --proofs <path>           artifact IDs to resolve from the canonical Evidence Envelope
  --json                    emit typed JSON
`;

function opt(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || '';
  return argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

function inside(root, target) {
  return isProjectContainedPath(root, target);
}

function readProjectJson(projectRoot, pathValue, label, optional = false) {
  if (!pathValue && optional) return null;
  if (!pathValue) throw Object.assign(new Error(`${label} path is required`), { code: 'BRIDGE_ARGUMENT_INVALID' });
  const rootReal = realpathSync(projectRoot);
  const path = resolve(projectRoot, pathValue);
  if (!inside(rootReal, path)) throw Object.assign(new Error(`${label} escapes the project`), { code: 'BRIDGE_INPUT_ESCAPE' });
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw Object.assign(new Error(`${label} file not found`), { code: 'BRIDGE_INPUT_MISSING' });
  }
  const pathReal = realpathSync(path);
  if (!inside(rootReal, pathReal)) throw Object.assign(new Error(`${label} escapes the project`), { code: 'BRIDGE_INPUT_ESCAPE' });
  if (lstatSync(pathReal).size > 1024 * 1024) throw Object.assign(new Error(`${label} exceeds 1 MiB`), { code: 'BRIDGE_INPUT_LIMIT' });
  try {
    return JSON.parse(readFileSync(pathReal, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`${label} is not valid JSON: ${error.message}`), { code: 'BRIDGE_INPUT_INVALID' });
  }
}

function write(value, json) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

export function runEcosystemBridge(argv = []) {
  const sub = argv[0];
  if (!sub || ['help', '--help', '-h'].includes(sub)) {
    process.stdout.write(BRIDGE_HELP);
    return 0;
  }
  const json = argv.includes('--json');
  const projectRoot = resolve(opt(argv, '--project') || process.cwd());
  try {
    if (sub === 'status') {
      const result = inspectEcosystemBridges({ projectRoot, configPath: opt(argv, '--config'), fs: bridgeFs });
      write(result, json);
      return result.ok ? 0 : 1;
    }
    const loaded = readBridgeConfig(projectRoot, opt(argv, '--config'), { fs: bridgeFs });
    if (sub === 'import-spec-kit') {
      if (opt(argv, '--previous')) {
        throw Object.assign(new Error('--previous cannot replace the canonical Vault baseline'), { code: 'BRIDGE_ARGUMENT_INVALID' });
      }
      const adapter = loaded.config.adapters['spec-kit'];
      if (!adapter.enabled) {
        const result = importSpecKitProjection({ projectRoot, config: loaded.config, fs: bridgeFs });
        write(result, json);
        return result.ok ? 0 : 1;
      }
      const changeSlug = opt(argv, '--change');
      if (!changeSlug) throw Object.assign(new Error('--change is required for the canonical Spec Kit baseline'), { code: 'BRIDGE_BASELINE_CONTEXT_INVALID' });
      const vault = resolveProjectVault({ startDir: projectRoot, explicitVault: opt(argv, '--vault') || '' }).base;
      const baseline = readSpecKitBaseline(vault, changeSlug);
      const current = importSpecKitProjection({ projectRoot, config: loaded.config, previousProjection: baseline, fs: bridgeFs });
      let result = current;
      if (argv.includes('--accept-baseline')) {
        if (baseline && baseline.projection_id !== current.projection_id) {
          result = sealBridgeProjection({
            ...current, ok: false,
            diagnostics: [...current.diagnostics, bridgeDiagnostic('BRIDGE_BASELINE_STALE', {
              adapter: 'spec-kit', message: 'canonical Spec Kit baseline already exists and cannot be replaced implicitly',
            })],
          });
        } else if (!baseline && current.ok) writeSpecKitBaseline(vault, changeSlug, current);
      } else if (!baseline) {
        result = sealBridgeProjection({
          ...current, ok: false,
          diagnostics: [...current.diagnostics, bridgeDiagnostic('BRIDGE_BASELINE_MISSING', {
            adapter: 'spec-kit', message: 'anchor the first projection with --accept-baseline',
          })],
        });
      }
      write(result, json);
      return result.ok ? 0 : 1;
    }
    if (sub === 'export-status') {
      const sourceProjection = readProjectJson(projectRoot, opt(argv, '--spec-projection'), 'Spec Kit projection');
      const taskContract = readProjectJson(projectRoot, opt(argv, '--task-contract'), 'task contract', true);
      const artifactInput = readProjectJson(projectRoot, opt(argv, '--input'), 'artifact input', true);
      const result = buildSpecKitStatusProjection({
        sourceProjection,
        taskContracts: taskContract ? [taskContract] : [],
        artifacts: artifactInput ? (Array.isArray(artifactInput) ? artifactInput : artifactInput.artifacts || []) : [],
      });
      write(result, json);
      return 0;
    }
    if (sub === 'dispatch-superpowers') {
      const taskId = opt(argv, '--task-id');
      if (!taskId) throw Object.assign(new Error('task id is required'), { code: 'BRIDGE_ARGUMENT_INVALID' });
      const submitted = readProjectJson(projectRoot, opt(argv, '--task-contract'), 'task contract', true);
      const specKitProjection = readProjectJson(projectRoot, opt(argv, '--spec-projection'), 'Spec Kit projection', true);
      const adapter = loaded.config.adapters.superpowers;
      const adapterRoot = inspectBridgeAdapterRoot(projectRoot, adapter.root || '.superpowers', { adapter: 'superpowers', fs: bridgeFs });
      if (!adapterRoot.valid) {
        const result = {
          schema_version: 1, adapter: 'superpowers', active: false, ok: false,
          diagnostics: adapterRoot.diagnostics,
        };
        write(result, json);
        return 1;
      }
      const present = adapterRoot.present;
      const vault = resolveProjectVault({
        startDir: projectRoot,
        explicitVault: opt(argv, '--vault') || '',
      }).base;
      const changeSlug = opt(argv, '--change');
      let baselineProjection = null;
      if (loaded.config.adapters['spec-kit'].enabled) {
        if (!changeSlug || !specKitProjection) {
          const result = {
            schema_version: 1, adapter: 'superpowers', active: true, ok: false,
            diagnostics: [bridgeDiagnostic('BRIDGE_BASELINE_MISSING', {
              adapter: 'spec-kit', message: 'dispatch requires --change and --spec-projection when Spec Kit is active',
            })],
          };
          write(result, json);
          return 1;
        }
        baselineProjection = readSpecKitBaseline(vault, changeSlug);
        if (!baselineProjection) {
          const result = {
            schema_version: 1, adapter: 'superpowers', active: true, ok: false,
            diagnostics: [bridgeDiagnostic('BRIDGE_BASELINE_MISSING', {
              adapter: 'spec-kit', message: 'canonical Spec Kit baseline is missing from the bound Vault change',
            })],
          };
          write(result, json);
          return 1;
        }
      }
      const authorityArgs = ['--project', projectRoot, '--vault', vault, '--task-id', taskId];
      for (const name of ['--session', '--change']) {
        const value = opt(argv, name);
        if (value) authorityArgs.push(name, value);
      }
      const result = buildCanonicalExternalTaskDispatch({
        adapter: 'superpowers',
        authorityArgv: authorityArgs,
        taskId,
        submittedTaskContract: submitted,
        projectRoot,
        specKitProjection,
        baselineProjection,
        config: loaded.config,
        detectedVersion: adapter.version || '',
        present,
      });
      write(result, json);
      return result.ok ? 0 : 1;
    }
    if (sub === 'verify-artifacts') {
      const input = readProjectJson(projectRoot, opt(argv, '--input'), 'artifact input');
      const proofs = readProjectJson(projectRoot, opt(argv, '--proofs'), 'proof input');
      const artifacts = ingestSuperpowersArtifacts(Array.isArray(input) ? input : input.artifacts);
      const proofList = (Array.isArray(proofs) ? proofs : proofs.proofs) || [];
      const canonicalRequested = proofList.some((proof) => proof?.type === 'evidence-envelope');
      const changeSlug = opt(argv, '--change');
      const vault = canonicalRequested && changeSlug
        ? resolveProjectVault({ startDir: projectRoot, explicitVault: opt(argv, '--vault') || '' }).base
        : '';
      const verified = artifacts.map((artifact) => {
        const artifactProofs = proofList.filter((proof) => (
          !proof.external_id || proof.external_id === artifact.external_id
        ));
        const canonicalProofs = vault ? artifactProofs.map((proof) => deriveCanonicalArtifactProof({
          artifact, proof, projectRoot, vaultBase: vault, changeSlug,
          sessionId: opt(argv, '--session') || '',
        })).filter(Boolean) : [];
        return verifyExternalArtifact(artifact, { proofs: artifactProofs, canonicalProofs });
      });
      const result = { schema_version: 1, ok: verified.every((item) => item.authority === 'verified'), artifacts: verified };
      write(result, json);
      return result.ok ? 0 : 1;
    }
    throw Object.assign(new Error(`unknown bridge subcommand: ${sub}`), { code: 'BRIDGE_SUBCOMMAND_UNKNOWN' });
  } catch (error) {
    const payload = { ok: false, code: error?.code || 'BRIDGE_COMMAND_FAILED', error: error?.message || String(error) };
    process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `wendkeep bridge: ${payload.code}: ${payload.error}\n`);
    return 2;
  }
}
