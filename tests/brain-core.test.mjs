import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBrainDigest, buildBrainIndex } from '../hooks/brain-core.mjs';

test('[req:MEM-HYB-12] digest renders only a resolved ADR with its sanitized title', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-brain-core-'));
  const sessionDir = join(vault, '02-Sessões', '2026', '08-AGO', 'DIA 16');
  const adrDir = join(vault, '04-Decisões', '2026', '08-AGO');
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(adrDir, { recursive: true });
    writeFileSync(join(vault, '.brain', 'CORE.md'), '# Curated core sentinel\n');
    writeFileSync(join(sessionDir, '06-02-session.md'), `---
type: session
date: 2026-08-16
provider: codex
status: active
summary: fixture session
---

# Fixture session

## Decisões geradas nesta sessão

- [[04-Decisões/2026/08-AGO/ADR-0123-real-decision]]
- [[04-Decisões/2026/08-AGO/ADR-0999-missing-decision]]
- [[04-Decisões/2026/08-AGO/ADR-0888-truncated…]]
`);
    writeFileSync(join(adrDir, 'ADR-0123-real-decision.md'), `---
type: decision
status: accepted
---

# ADR-0123 — Decisão real sanitizada

Conteúdo artificial da decisão.
`);

    const rows = buildBrainIndex(vault);
    const digest = buildBrainDigest(vault, rows).join('\n');

    assert.match(
      digest,
      /Decisão:\s*\[\[04-Decisões\/2026\/08-AGO\/ADR-0123-real-decision\]\].*Decisão real sanitizada/i,
    );
    assert.doesNotMatch(digest, /ADR-0999-missing-decision|ADR-0888-truncated/i);
    assert.doesNotMatch(digest, /Decisão:\s*\[\[[^\]]+\]\]\s*$/m);
    assert.equal(readFileSync(join(vault, '.brain', 'CORE.md'), 'utf8'), '# Curated core sentinel\n');
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
