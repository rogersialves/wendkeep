// Host hook specifications shared by the installer and CLI. This catalog is
// data-only and side-effect free so host adapters can import it cheaply.

// The three Claude Code session hooks, expressed as `wendkeep hook <name>` so the
// installed package is the single source of truth (update with `npm update wendkeep`,
// no re-copying). Returned as a spec the merge logic folds into settings.json.
export const SESSION_HOOKS = [
  // Memory + active-change injection. Runs FIRST on SessionStart (order -10, folds before
  // session-start) so the agent gets CORE + DIGEST + the active change + lessons as context.
  // matcher 'startup|clear|compact' re-injects after a compaction/clear, not only cold startup.
  // timeout 45 (was 15): measured ~4s warm via npx, but Windows startup contention (several npx
  // cold-starts at once — a sibling MCP took 26s in a real log) blew 15s and silently dropped the
  // memory injection for the whole session.
  { event: 'SessionStart', matcher: 'startup|clear|compact', name: 'brain-inject', timeout: 45, order: -10, codex: true, statusMessage: 'wendkeep: injecting memory + active change' },
  { event: 'SessionStart', matcher: 'startup', name: 'session-start', timeout: 30, codex: true, statusMessage: 'wendkeep: opening Obsidian session' },
  // Observer publication is a derived, fail-open projection and therefore runs only after
  // the local lifecycle hook has written its authoritative session state.
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', name: 'observer-publish', timeout: 5, order: 20, codex: true, statusMessage: 'wendkeep: publishing local observer snapshot' },
  { event: 'Stop', matcher: null, name: 'session-stop', timeout: 60, codex: true, statusMessage: 'wendkeep: writing session checkpoint' },
  { event: 'Stop', matcher: null, name: 'observer-publish', timeout: 5, order: 20, codex: true, statusMessage: 'wendkeep: publishing local observer snapshot' },
  { event: 'UserPromptSubmit', matcher: null, name: 'session-ensure', timeout: 30, codex: true, statusMessage: 'wendkeep: ensuring active session' },
  { event: 'UserPromptSubmit', matcher: null, name: 'evidence-context', timeout: 10, order: 5, codex: true, statusMessage: 'wendkeep: retrieving relevant evidence' },
  // Capture an interactive decision (AskUserQuestion) — options + the user's choice — into 04-Decisões.
  // codex: AskUserQuestion is a Claude-only tool; there is nothing to match on.
  { event: 'PostToolUse', matcher: 'AskUserQuestion', name: 'decision-capture', timeout: 15, statusMessage: 'wendkeep: recording decision' },
  // Refresh subagent/workflow telemetry as each subagent finishes (resilient to a missed Stop).
  { event: 'SubagentStop', matcher: null, name: 'subagent-stop', timeout: 20, codex: true, statusMessage: 'wendkeep: subagent telemetry' },
  // Publish the SQL observer projection after the subagent telemetry is settled.
  { event: 'SubagentStop', matcher: null, name: 'observer-publish', timeout: 5, order: 20, codex: true, statusMessage: 'wendkeep: publishing local observer usage' },
  // Log plan/task progress into the active session note when a task is marked complete.
  // codex: TaskCompleted is not in Codex's hook event enum.
  { event: 'TaskCompleted', matcher: null, name: 'task-log', timeout: 10, statusMessage: 'wendkeep: plan progress' },
];

export function hookCommand(name) {
  return `npx --no-install wendkeep hook ${name}`;
}

// O checkout do próprio WendKeep não depende do pacote publicado. Seus hooks versionados
// executam o binário do working tree para que sync/dogfood não recrie a autodependência.
export function hookCommandWorkingTree(name) {
  return `node ./bin/wendkeep.mjs hook ${name}`;
}

// Forma node-direta do comando de hook: 1 processo (~100-250ms) em vez dos 3 do npx (cold-start
// de segundos no Windows). Usada pelos hooks de ALTA FREQUÊNCIA (por prompt / por tool-call)
// quando o projeto tem wendkeep instalado localmente; o init decide (hookCommandFor).
export function hookCommandLocal(name) {
  return `node "${'${CLAUDE_PROJECT_DIR}'}/node_modules/wendkeep/hooks/${name}.mjs"`;
}

export function hookCommandLocalLegacy(name) {
  return `node node_modules/wendkeep/hooks/${name}.mjs`;
}

// Hooks do lifecycle de change (0.31.0) — enforcement do loop a2. Nudges (contexto/aviso/
// cobrança/captura de plano) e gate (deny/ask no Bash/PreToolUse). Separados em dois grupos para
// preservar a opção futura de gates opt-in; hoje o init wira TODOS por default.
// preferLocal: alta frequência → invocação node-direta quando houver instalação local.
export const CHANGE_NUDGE_HOOKS = [
  { event: 'UserPromptSubmit', matcher: null, name: 'change-context', timeout: 15, order: 10, preferLocal: true, codex: true, statusMessage: 'wendkeep: change ping' },
  // codex: reads tool_input.file_path, which Codex's apply_patch envelope does not carry.
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', name: 'change-warn', timeout: 10, order: 10, preferLocal: true, statusMessage: 'wendkeep: change warn' },
  // codex: no ExitPlanMode equivalent — update_plan is the running TODO list, not an approval.
  { event: 'PostToolUse', matcher: 'ExitPlanMode', name: 'plan-capture', timeout: 15, order: 10, preferLocal: true, statusMessage: 'wendkeep: capturing approved plan' },
  { event: 'Stop', matcher: null, name: 'change-nag', timeout: 15, order: 10, preferLocal: true, codex: true, statusMessage: 'wendkeep: open tasks check' },
];

export const CHANGE_GATE_HOOKS = [
  // The adapter accepts Codex's object, raw-string and argv forms and fails closed when a
  // mutable target cannot be proven. Keep the matcher narrow to the payloads covered by tests.
  { event: 'PreToolUse', matcher: 'Bash|exec_command|apply_patch|mcp__.*', name: 'change-guard', timeout: 10, order: 10, preferLocal: true, codex: true, statusMessage: 'wendkeep: change gate' },
];

// --- Codex projection ---------------------------------------------------------
// Codex reads <project>/.codex/hooks.json (PascalCase event keys, same group shape as
// Claude's settings.json). Only specs that opt in with `codex: true` are projected — the
// rest carry a `// codex:` comment above them saying why. Three deltas from Claude, each
// verified against codex-rs and each silent when wrong: the timeout key is `timeoutSec`
// (`timeout` is not a field and falls through to a 600s default), there is no
// ${CLAUDE_PROJECT_DIR} so `preferLocal` never applies, and matcher is honoured only for
// events whose host contract is covered by tests.
export const CODEX_MATCHER_EVENTS = new Set(['SessionStart', 'PreToolUse']);

export function codexHookSpecs(specs) {
  return specs.filter((h) => h.codex === true && !h.command);
}

export function codexHookEntry(spec) {
  const entry = { type: 'command', command: hookCommand(spec.name), timeoutSec: spec.timeout };
  if (spec.statusMessage) entry.statusMessage = spec.statusMessage;
  return entry;
}
