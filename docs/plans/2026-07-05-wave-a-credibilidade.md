# Wave A — Credibilidade (plano de implementação)

> Implementa [docs/13](../13-wave-a-credibilidade.md). Decisões: Q1=A (req-ID no título),
> Q2=B (pacote+verdict, gate exige), Q3=delegar (Wave B), Q4=A (archive sempre exige verdict).
> **Para workers:** superpowers:executing-plans. TDD, `node --test`, zero dep. "Commit" = checkpoint verde.

**Goal:** archive só passa com sensores verdes E `verdict.json` (ok + cobre os `[req:]`);
rastro req→task→verdict→ADR; skills TLC-grade.

## Constraints
- ESM, zero dep. Retrocompat: specs 0.4.0 (`### Requisito: <nome>` sem ID) seguem válidos.
- Req-ID: `^[A-Z][A-Z0-9]*-\d+$`. Identidade do requisito = ID se houver, senão nome.
- Contratos: `verificacao.json`, `verdict.json` conforme docs/13.

---

### Task 1: Req-ID no spec-core + `[req:]` nas tarefas

**Files:** `hooks/spec-core.mjs`, `hooks/change-core.mjs`; Test `tests/spec-core.test.mjs`, `tests/change-core.test.mjs`.

**Produces:** `parseRequirements(md) -> [{id, name, body}]`; delta/render/apply keyed por `id||name`; `parseTasks` item ganha `req`.

- [ ] **Step 1 (test):** em `tests/spec-core.test.mjs`:
```js
test('parseRequirements: extrai id do heading; retrocompat sem id', () => {
  const md = '## Requisitos\n\n### Requisito: GATE-1 — trava sem verde\ncorpo\n\n### Requisito: sem id\nx\n';
  const r = parseRequirements(md);
  assert.equal(r[0].id, 'GATE-1'); assert.equal(r[0].name, 'trava sem verde');
  assert.equal(r[1].id, null); assert.equal(r[1].name, 'sem id');
});
test('applyDelta: casa por id; render mantém "ID — nome"', () => {
  const base = parseRequirements('### Requisito: GATE-1 — antigo\na\n');
  const delta = { added: [], modified: parseRequirements('### Requisito: GATE-1 — novo nome\nb\n'), removed: [] };
  const { reqs } = applyDelta(base, delta);
  assert.equal(reqs.length, 1); assert.equal(reqs[0].id, 'GATE-1'); assert.equal(reqs[0].name, 'novo nome');
  assert.match(renderSpec('gate', reqs, {}), /### Requisito: GATE-1 — novo nome/);
});
```
Em `tests/change-core.test.mjs` (junto do teste de sensor):
```js
test('parseTasks: extrai [req:ID] além de [sensor:]', () => {
  const t = parseTasks('- [ ] 3.2 faz [req:GATE-1] [sensor:tests]\n');
  assert.equal(t[0].req, 'GATE-1'); assert.equal(t[0].sensor, 'tests'); assert.equal(t[0].text, 'faz');
});
```

- [ ] **Step 2 (fail):** `node --test tests/spec-core.test.mjs tests/change-core.test.mjs`.

- [ ] **Step 3 (impl):**
  - `spec-core.parseRequirements`: após capturar o heading `(.+)`, separar id/nome:
    ```js
    const idM = raw.match(/^([A-Z][A-Z0-9]*-\d+)\s*—\s*(.+)$/);
    const id = idM ? idM[1] : null;
    const name = idM ? idM[2].trim() : raw.trim();
    reqs.push({ id, name, body });
    ```
    (o loop passa a guardar `raw` = `matches[i][1]`.)
  - `key(r) = r.id || r.name`. `applyDelta`: trocar todo uso de `r.name` como chave por `key(r)`
    (order/map keyed por key); manter `{id,name,body}` no objeto.
  - `renderSpec`: bloco = `### Requisito: ${r.id ? `${r.id} — ${r.name}` : r.name}\n${r.body}`.
  - `parseDelta`: `parseRequirements` já traz id — nada extra; `removed` vira lista de `key` (id||name):
    `.map((r) => r.id || r.name)`.
  - `change-core.parseTasks`: adicionar `const reqRe = /\[req:\s*([A-Z][A-Z0-9]*-\d+)\]/;`, extrair
    `req`, remover do texto (igual sensor), incluir `...(req ? { req } : {})`.

- [ ] **Step 4 (pass):** os dois arquivos verdes.
- [ ] **Step 5 (checkpoint):** `npm test` verde (specs 0.4.0 retrocompat — testes existentes seguem).

---

### Task 2: `verify --deep` monta o pacote + auto-verdict trivial

**Files:** `src/verify.mjs`; Test `tests/change-cli.test.mjs`.

**Produces:** `wendkeep verify --deep` → `<change>/verificacao.json`; se zero `[req:]` + sensores verdes, auto-escreve `verdict.json`.

- [ ] **Step 1 (test):** em `tests/change-cli.test.mjs`:
```js
test('verify --deep: change trivial auto-escreve verdict; com req só monta pacote', () => {
  const vault = mkdtempSync(join(tmpdir(), 'wk-deep-'));
  const proj = mkdtempSync(join(tmpdir(), 'wk-deepp-'));
  const spawn = (a) => spawnSync(process.execPath, [BIN, ...a, '--vault', vault, '--project', proj], { encoding: 'utf8' });
  try {
    mkdirSync(join(vault, '.brain'), { recursive: true });
    writeFileSync(join(proj, 'wendkeep.sensors.json'), JSON.stringify({ version: 1, sensors: [{ id: 'ok', severity: 'critical', command: 'exit 0' }] }));
    // trivial: sem [req:]
    mkdirSync(join(vault, '08-Mudanças', 't'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 't', 'tarefas.md'), '- [ ] 1.1 faz [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: t\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verificacao.json')));
    assert.ok(existsSync(join(vault, '08-Mudanças', 't', 'verdict.json')), 'trivial auto-verdict');
    // com req: pacote sim, verdict não
    mkdirSync(join(vault, '08-Mudanças', 'r'), { recursive: true });
    writeFileSync(join(vault, '08-Mudanças', 'r', 'tarefas.md'), '- [ ] 1.1 faz [req:X-1] [sensor:ok]\n');
    writeFileSync(join(vault, '.brain', 'CURRENT_CHANGE.md'), 'change: r\n');
    assert.equal(spawn(['verify', '--deep']).status, 0);
    assert.ok(existsSync(join(vault, '08-Mudanças', 'r', 'verificacao.json')));
    assert.ok(!existsSync(join(vault, '08-Mudanças', 'r', 'verdict.json')), 'com req exige passe do agente');
  } finally { rmSync(vault, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});
```

- [ ] **Step 2 (fail).**

- [ ] **Step 3 (impl):** em `src/verify.mjs`, `runVerify` detecta `--deep`. Após rodar sensores +
  escrever `evidencia.json` (fluxo atual), se `--deep`:
  ```js
  if (argv.includes('--deep')) {
    const tasks = parseTasks(tarefas);
    const reqIds = [...new Set(tasks.map((t) => t.req).filter(Boolean))];
    const pkg = { slug, generatedAt: null, requirements: reqIds.map((id) => ({ id })), tasks: tasks.map((t) => ({ id: t.id, text: t.text, req: t.req || null, done: t.done })), sensors: evidence };
    writeFileSync(join(changeDir, 'verificacao.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    if (reqIds.length === 0 && ok) {
      writeFileSync(join(changeDir, 'verdict.json'), `${JSON.stringify({ slug, ok: true, coverage: [], notes: ['trivial: sem requisito'] }, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`verify --deep: pacote escrito${reqIds.length ? ' — rode a skill wk-verify' : ' (verdict trivial)'}\n`);
    process.exit(reqIds.length === 0 && ok ? 0 : 0);
  }
  ```
  (`generatedAt: null` — sem `Date.now` determinístico nos testes; o agente/gate não dependem do timestamp. `ok` = resultado do gate de sensores já computado acima.)

- [ ] **Step 4 (pass).** **Step 5 (checkpoint):** `npm test`.

---

### Task 3: gate exige verdict + ADR lista req-IDs

**Files:** `hooks/spec-core.mjs` (helper), `src/change.mjs`, `hooks/change-core.mjs`; Test `tests/change-cli.test.mjs`, `tests/spec-core.test.mjs`.

**Produces:** `evaluateVerdict(verdict, reqIds) -> {ok, missing}`; archive bloqueia sem verdict válido; ADR lista IDs.

- [ ] **Step 1 (test):** unit em `tests/spec-core.test.mjs`:
```js
test('evaluateVerdict: ok cobre todos os req; falta bloqueia', () => {
  const v = { ok: true, coverage: [{ req: 'A-1', covered: true }] };
  assert.deepEqual(evaluateVerdict(v, ['A-1']), { ok: true, missing: [] });
  assert.deepEqual(evaluateVerdict(v, ['A-1', 'A-2']), { ok: false, missing: ['A-2'] });
  assert.deepEqual(evaluateVerdict({ ok: false, coverage: [] }, []), { ok: false, missing: [] });
  assert.deepEqual(evaluateVerdict(null, []), { ok: false, missing: [] });
});
```
e2e em `tests/change-cli.test.mjs`: change com `[req:X-1]`, sensor verde, sem verdict → archive
bloqueia (`/verdict/i`); escrevendo `verdict.json` `{ok:true,coverage:[{req:'X-1',covered:true}]}` → archive passa, ADR contém `X-1`.

- [ ] **Step 2 (fail).**

- [ ] **Step 3 (impl):**
  - `spec-core`: `export function evaluateVerdict(verdict, reqIds) { if (!verdict || verdict.ok !== true) return { ok: false, missing: [] }; const covered = new Set((verdict.coverage||[]).filter((c)=>c.covered).map((c)=>c.req)); const missing = (reqIds||[]).filter((r)=>!covered.has(r)); return { ok: missing.length===0, missing }; }`
  - `src/change.mjs` gate closure: além do `evaluateGate(sensores)`, ler `verdict.json` + `evaluateVerdict`:
    ```js
    const reqIds = [...new Set(parseTasks(read tarefas).map((t)=>t.req).filter(Boolean))];
    let verdict = null; try { verdict = JSON.parse(readFileSync(join(dir,'verdict.json'),'utf8')); } catch {}
    const v = evaluateVerdict(verdict, reqIds);
    const s = evaluateGate(evidence, required);
    if (!s.ok) return { ok:false, failing:s.failing };
    if (!v.ok) return { ok:false, failing: verdict ? [`verdict incompleto: ${v.missing.join(',')}`] : ['sem verdict — rode verify --deep'] };
    return { ok:true, failing:[] };
    ```
  - `change-core.archiveChange`: já lista promoted specs no ADR; adicionar linha de req-IDs a partir das tarefas (ler `src/tarefas.md` antes do rename): `Requisitos: X-1, Y-2.` (ou wikilink pro spec).

- [ ] **Step 4 (pass).** **Step 5 (checkpoint):** `npm test`; demo: change com req bloqueia até verdict.

---

### Task 4: Skills TLC-grade

**Files:** `src/skills-seed.mjs`; Test `tests/skills-seed.test.mjs`.

**Produces:** `wk-tdd`/`wk-brainstorming` reescritas, `wk-verify` nova, `wk-workflow` cita `verify --deep`. `WK_SKILLS` passa de 5 → 6.

- [ ] **Step 1 (test):** em `tests/skills-seed.test.mjs`:
```js
test('wk-verify presente; wk-tdd/brainstorming com disciplina TLC', () => {
  const by = Object.fromEntries(WK_SKILLS.map((s) => [s.name, s.body]));
  assert.ok(by['wk-verify'], 'wk-verify existe');
  assert.match(by['wk-verify'], /autor.*verificador|read-only|verdict/i);
  assert.match(by['wk-tdd'], /spec|adequa|raso|litmus/i);
  assert.match(by['wk-brainstorming'], /out-of-scope|assumption|closure|ambigu/i);
  assert.match(by['wk-workflow'], /verify --deep/);
});
```
(o teste "5 skills" existente vira ≥6 — ajustar o array esperado pra incluir `wk-verify`.)

- [ ] **Step 2 (fail).**

- [ ] **Step 3 (impl):** em `src/skills-seed.mjs` reescrever os corpos (prose PT-BR nativa, ~40–60 linhas cada):
  - **wk-tdd** + seções: *Testes derivados do spec* (escrever do critério de aceite, não de ler o código);
    *Litmus não-raso* (rejeitar asserção que passa sob impl errada; afirmar valor/estado, nunca "mock chamado");
    *Adequação* (todo critério coberto com evidência file:line; todo teste rastreia um requisito);
    *Aprende o projeto* (amostrar 5–10 testes; ler AGENTS.md/.cursor/rules/CI).
  - **wk-brainstorming** + *Closure gate* (resolver ambiguidade com o usuário ou logar assumption
    assinada; registrar cinzas declinados) + *tabela out-of-scope*.
  - **wk-verify** (nova): passe fresco read-only, autor≠verificador; lê `verificacao.json`;
    re-deriva cobertura do `07-Specs`; outcome check ancorado no spec; grava `verdict.json`
    (`{slug, ok, coverage:[{req,covered,evidence}], notes}`). No Claude pode spawnar sub-agente.
  - **wk-workflow**: inserir `wendkeep verify --deep` + skill `wk-verify` entre *apply* e *archive*.

- [ ] **Step 4 (pass).** **Step 5 (checkpoint):** `npm test` + demo `init` semeia 6 skills, sync entrega.

---

### Task 5: Contrato v1 (`docs/14-harness-contract.md`)

**Files:** Create `docs/14-harness-contract.md`.

- [ ] **Step 1:** escrever a referência de extensão: sensor (`type: command|mutation|verifier`),
  req-ID, `[req:]`/`[sensor:]`, spec delta, SKILL.md, `verificacao.json`, `verdict.json`, lesson —
  cada um com o formato exato + exemplo. Marcar `harness contract v1`; notar o que é Wave B (mutation/verifier types, lesson).
- [ ] **Step 2 (checkpoint):** `npm test` verde; `npm run check`.

---

## Self-Review
- **Cobertura docs/13:** req-ID+rastro (T1) ✓; verify --deep+pacote+auto-verdict (T2) ✓; gate exige verdict+ADR IDs (T3) ✓; skills (T4) ✓; contrato (T5) ✓.
- **Retrocompat:** parseRequirements id=null pra headings antigos; parseTasks req opcional; gate exige verdict SEMPRE (Q4=A) — muda o comportamento do archive (documentar no CHANGELOG 0.5.0).
- **Consistência de tipos:** `{id,name,body}` / `key=id||name` / `verdict{ok,coverage[{req,covered,evidence}]}` / `evaluateVerdict(verdict,reqIds)->{ok,missing}` coerentes T1–T3.

## Verificação e2e
`change new` → tarefa `[req:GATE-1]` → spec `### Requisito: GATE-1 — …` → `verify` (sensores) →
`verify --deep` (pacote) → agente/`wk-verify` grava verdict → `archive` passa, ADR lista GATE-1,
spec promovido. Change trivial: `verify --deep` auto-verdict → archive passa. `npm test` verde.
