import { createHash } from 'node:crypto';

const TABLES = {
  documents: { table: 'documents', time: 'captured_at', id: 'document_id' },
  calls: { table: 'llm_calls', time: 'occurred_at', id: 'call_pk' },
  transcripts: { table: 'transcripts', time: 'occurred_at', id: 'transcript_pk' },
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

export function verifyObserverPurgeReceipt(receipt = {}) {
  const candidate = { ...receipt };
  const expected = String(candidate.receipt_hash || '');
  delete candidate.receipt_hash;
  delete candidate.idempotent;
  return Boolean(expected) && digest(candidate) === expected;
}

export function purgeObserverData(db, {
  projectId, before, classes = Object.keys(TABLES), now = new Date().toISOString(), dryRun = false,
  operationId = '', beforeCommit, receiptSink,
} = {}) {
  const normalizedClasses = [...new Set(classes)].sort();
  if (!normalizedClasses.length || normalizedClasses.some((item) => !TABLES[item])) {
    throw Object.assign(new Error('classes de purge inválidas.'), { code: 'observer_purge_invalid' });
  }
  const cutoff = new Date(before).toISOString();
  const requestHash = digest({ project_id: projectId, before: cutoff, classes: normalizedClasses });
  db.exec('BEGIN IMMEDIATE');
  let transactionOpen = true;
  try {
    const requestedReceiptId = operationId
      ? digest({ request_hash: requestHash, operation_id: String(operationId) }).slice(7, 39)
      : '';
    const candidates = Object.fromEntries(normalizedClasses.map((dataClass) => {
      const spec = TABLES[dataClass];
      const rows = db.prepare(`SELECT ${spec.id} AS id FROM ${spec.table} WHERE project_id = ? AND ${spec.time} < ? ORDER BY ${spec.id}`).all(projectId, cutoff);
      return [dataClass, rows.map((row) => row.id)];
    }));
    const counts = Object.fromEntries(normalizedClasses.map((dataClass) => [dataClass, candidates[dataClass].length]));
    if (dryRun) {
      db.exec('COMMIT');
      transactionOpen = false;
      return { dry_run: true, project_id: projectId, before: cutoff, classes: normalizedClasses, counts };
    }
    const noCandidates = Object.values(counts).every((count) => count === 0);
    if (noCandidates) {
      const previous = requestedReceiptId
        ? db.prepare('SELECT receipt_json FROM observer_purge_receipts WHERE receipt_id = ?').get(requestedReceiptId)
        : db.prepare('SELECT receipt_json FROM observer_purge_receipts WHERE project_id = ? AND request_hash = ? ORDER BY purged_at DESC LIMIT 1').get(projectId, requestHash);
      if (previous) {
        db.exec('COMMIT');
        transactionOpen = false;
        const replay = { ...JSON.parse(previous.receipt_json), idempotent: true };
        receiptSink?.(replay);
        return replay;
      }
    }
    const operationExists = requestedReceiptId && db.prepare('SELECT receipt_id FROM observer_purge_receipts WHERE receipt_id = ?').get(requestedReceiptId);
    const receiptId = operationExists
      ? digest({ request_hash: requestHash, operation_id: String(operationId), candidates }).slice(7, 39)
      : requestedReceiptId || digest({ request_hash: requestHash, candidates }).slice(7, 39);
    const receipt = {
      schema_version: 1, receipt_id: receiptId, project_id: projectId, before: cutoff,
      classes: normalizedClasses, counts, purged_at: new Date(now).toISOString(),
    };
    receipt.receipt_hash = digest(receipt);
    for (const dataClass of normalizedClasses) {
      const spec = TABLES[dataClass];
      if (dataClass === 'documents' && db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evidence_chunks_fts'").get().count) {
        db.prepare('DELETE FROM evidence_chunks_fts WHERE project_id = ? AND logical_path IN (SELECT logical_path FROM documents WHERE project_id = ? AND captured_at < ?)').run(projectId, projectId, cutoff);
      }
      db.prepare(`DELETE FROM ${spec.table} WHERE project_id = ? AND ${spec.time} < ?`).run(projectId, cutoff);
      const kind = dataClass === 'documents' ? 'document.%' : dataClass === 'calls' ? 'llm_call' : 'transcript.upsert';
      const comparator = dataClass === 'documents' ? 'LIKE' : '=';
      db.prepare(`DELETE FROM ingest_events WHERE project_id = ? AND kind ${comparator} ? AND occurred_at < ?`).run(projectId, kind, cutoff);
    }
    beforeCommit?.(receipt);
    db.prepare(`INSERT INTO observer_purge_receipts(receipt_id, project_id, request_hash, cutoff_at, classes_json, counts_json, purged_at, receipt_hash, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      receipt.receipt_id, projectId, requestHash, cutoff, JSON.stringify(normalizedClasses), JSON.stringify(counts),
      receipt.purged_at, receipt.receipt_hash, JSON.stringify(receipt),
    );
    db.exec('COMMIT');
    transactionOpen = false;
    receiptSink?.(receipt);
    return { ...receipt, idempotent: false };
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK');
    throw error;
  }
}
