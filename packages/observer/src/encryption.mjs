import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveKey(adapter, operation) {
  const candidate = adapter?.keyProvider?.({ keyId: adapter.keyId, operation });
  if (candidate && typeof candidate.then === 'function') {
    throw encryptionError('observer_encryption_key_invalid', 'Observer key provider deve ser síncrono para SQLite.');
  }
  const key = candidate == null ? null : Buffer.from(candidate);
  if (!key || key.byteLength !== 32) {
    throw encryptionError('observer_encryption_key_unavailable', 'Chave externa AES-256-GCM indisponível.');
  }
  return key;
}

export function createObserverEncryption({ keyProvider, required = false, keyId = '' } = {}) {
  if (required && typeof keyProvider !== 'function') {
    throw encryptionError('observer_encryption_key_unavailable', 'Key provider externo é obrigatório.');
  }
  return { algorithm: 'AES-256-GCM', keyProvider, required: Boolean(required), keyId: String(keyId || '') };
}

export function observerEncryptionFromEnvironment({ env = process.env, required = false } = {}) {
  const raw = String(env.WENDKEEP_OBSERVER_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    if (required) throw encryptionError('observer_encryption_key_unavailable', 'WENDKEEP_OBSERVER_ENCRYPTION_KEY é obrigatória.');
    return null;
  }
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) throw encryptionError('observer_encryption_key_invalid', 'WENDKEEP_OBSERVER_ENCRYPTION_KEY deve ter 32 bytes em hex/base64.');
  return createObserverEncryption({
    required: true,
    keyId: String(env.WENDKEEP_OBSERVER_ENCRYPTION_KEY_ID || 'observer-local-v1'),
    keyProvider: () => key,
  });
}

export function encryptObserverValue(adapter, value, { aad = '' } = {}) {
  if (!adapter?.required && typeof adapter?.keyProvider !== 'function') return null;
  const key = resolveKey(adapter, 'encrypt');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const plaintext = Buffer.from(String(value ?? ''), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schema_version: 1,
    algorithm: 'AES-256-GCM',
    key_id: adapter.keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptObserverValue(adapter, envelope, { aad = '' } = {}) {
  if (!envelope) return '';
  try {
    if (envelope.algorithm !== 'AES-256-GCM') throw new Error('unsupported envelope');
    const key = resolveKey({ ...adapter, keyId: envelope.key_id || adapter?.keyId }, 'decrypt');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    if (cause?.code === 'observer_encryption_key_unavailable') throw cause;
    throw encryptionError('observer_decryption_failed', 'Conteúdo protegido indisponível ou chave incorreta.');
  }
}
