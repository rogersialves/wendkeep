// dotcontext .context/config seeding + MCP-placement resolution.
// Seeds `memory-validation` (`wendkeep validate-memory`, valid in any wendkeep
// project) plus a sensor for each detected package.json script (test/typecheck/
// lint/build). Project-specific commands beyond that are left to `context init`.
// Non-destructive. Also resolves whether to add the project MCP entry (skip it
// when dotcontext is already configured globally in ~/.claude.json).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// package.json script -> sensor (only seeded if the script exists in the project).
const SCRIPT_SENSORS = [
  { script: 'typecheck', id: 'typecheck', name: 'Typecheck', severity: 'critical' },
  { script: 'test', id: 'tests', name: 'Tests', severity: 'critical' },
  { script: 'lint', id: 'lint', name: 'Lint', severity: 'warning' },
  { script: 'build', id: 'build', name: 'Build', severity: 'warning' },
];

export function renderSensorsJson(scripts = {}) {
  const sensors = [
    {
      id: 'memory-validation',
      name: 'CORE validation',
      description: 'valida .brain/CORE.md (cap 25 + 3 seções, sem segredos) — wendkeep',
      severity: 'critical',
      command: 'npx wendkeep validate-memory',
    },
  ];
  for (const m of SCRIPT_SENSORS) {
    if (scripts && scripts[m.script]) {
      sensors.push({
        id: m.id,
        name: m.name,
        description: `npm run ${m.script}`,
        severity: m.severity,
        command: `npm run ${m.script}`,
      });
    }
  }
  return `${JSON.stringify({ $schema: 'https://raw.githubusercontent.com/rogersialves/wendkeep/main/schema/wendkeep.sensors.schema.json', version: 1, source: 'manual', sensors }, null, 2)}\n`;
}

function readProjectScripts(projectPath) {
  try {
    return JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

// Create <project>/.context/config/sensors.json if absent (sensors auto-detected
// from the project's package.json scripts). Returns paths created.
export function seedDotcontext(projectPath) {
  const created = [];
  const configDir = join(projectPath, '.context', 'config');
  mkdirSync(configDir, { recursive: true });
  const sensorsPath = join(configDir, 'sensors.json');
  if (!existsSync(sensorsPath)) {
    writeFileSync(sensorsPath, renderSensorsJson(readProjectScripts(projectPath)), 'utf8');
    created.push(sensorsPath);
  }
  return created;
}

// True if ~/.claude.json already declares a global dotcontext MCP server. Best-effort.
export function globalHasDotcontext(claudeJsonPath = join(homedir(), '.claude.json')) {
  try {
    const data = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    return !!data?.mcpServers?.dotcontext;
  } catch {
    return false;
  }
}

// Whether to SKIP the project-scoped dotcontext MCP entry.
//   'none'    -> always skip
//   'project' -> never skip
//   'auto'/-- -> skip iff dotcontext is already global (avoid a duplicate server)
export function resolveDotcontextSkipMcp(flag, globalHas) {
  if (flag === 'none') return true;
  if (flag === 'project') return false;
  return !!globalHas;
}
