import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const migrationError = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

export const hashMigrationState = (value) => `sha256:${createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex')}`;

const atomicWriteJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
};

const readJson = (path, code, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw migrationError(code, `${label} is missing or corrupt`, error);
  }
};

export function createJsonResourceAdapter(resourcePath) {
  const path = resolve(resourcePath);
  return Object.freeze({
    path,
    read() {
      return readJson(path, 'WENDKEEP_MIGRATION_RESOURCE_CORRUPT', 'migration resource');
    },
    write(value) {
      atomicWriteJson(path, value);
    },
  });
}

export function createFileMigrationStore(rootPath) {
  const root = resolve(rootPath);
  const paths = Object.freeze({
    root,
    journal: join(root, 'migration-journal.json'),
    receipt: join(root, 'migration-receipt.json'),
    backup: join(root, 'migration-source.backup.json'),
  });
  mkdirSync(root, { recursive: true });
  return Object.freeze({
    paths,
    hasJournal: () => existsSync(paths.journal),
    readJournal: () => readJson(
      paths.journal,
      'WENDKEEP_MIGRATION_JOURNAL_CORRUPT',
      'migration journal',
    ),
    writeJournal: (journal) => atomicWriteJson(paths.journal, journal),
    removeJournal() {
      if (existsSync(paths.journal)) unlinkSync(paths.journal);
    },
    archiveCorruptJournal() {
      if (!existsSync(paths.journal)) return null;
      const archivePath = join(root, `migration-journal.corrupt-${Date.now()}.json`);
      renameSync(paths.journal, archivePath);
      return archivePath;
    },
    writeReceipt: (receipt) => atomicWriteJson(paths.receipt, receipt),
    readReceipt: () => readJson(
      paths.receipt,
      'WENDKEEP_MIGRATION_RECEIPT_CORRUPT',
      'migration receipt',
    ),
    readBackup: () => readJson(
      paths.backup,
      'WENDKEEP_MIGRATION_BACKUP_CORRUPT',
      'migration backup',
    ),
    backup(resourcePath) {
      if (!existsSync(paths.backup)) {
        copyFileSync(resourcePath, paths.backup);
      }
      return paths.backup;
    },
  });
}
