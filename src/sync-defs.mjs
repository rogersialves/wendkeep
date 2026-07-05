// Definitions layer: versioned custom agents/skills live in the vault's .brain so
// they travel with the project in git. They have no automatic consumer — agents
// read them from their own dirs — so `wendkeep sync-defs` copies them there:
//   .brain/agents/*.toml  -> <project>/.codex/agents/   (Codex agent format)
//   .brain/skills/<name>/ -> <project>/.claude/skills/   (skill format)
// .brain is the source of truth; re-run sync after editing. Copy (not symlink) for
// cross-platform robustness.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function syncDefs(vaultBase, projectPath) {
  const out = { agents: [], skills: [] };

  const agentsSrc = join(vaultBase, '.brain', 'agents');
  if (existsSync(agentsSrc)) {
    const dest = join(projectPath, '.codex', 'agents');
    for (const f of readdirSync(agentsSrc)) {
      if (!f.endsWith('.toml')) continue; // README.md etc. are docs, not defs
      mkdirSync(dest, { recursive: true });
      copyFileSync(join(agentsSrc, f), join(dest, f));
      out.agents.push(f);
    }
  }

  const skillsSrc = join(vaultBase, '.brain', 'skills');
  if (existsSync(skillsSrc)) {
    for (const name of readdirSync(skillsSrc)) {
      const dir = join(skillsSrc, name);
      if (!statSync(dir).isDirectory()) continue; // skip skills/README.md
      const dest = join(projectPath, '.claude', 'skills', name);
      mkdirSync(dest, { recursive: true });
      cpSync(dir, dest, { recursive: true });
      out.skills.push(name);
    }
  }

  return out;
}

// CLI entry for `wendkeep sync-defs`.
export function runSyncDefs(argv) {
  let vault;
  let project;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--vault') vault = argv[++i];
    else if (a.startsWith('--vault=')) vault = a.slice(8);
    else if (a === '--project') project = argv[++i];
    else if (a.startsWith('--project=')) project = a.slice(10);
  }
  const base = vault || process.env.OBSIDIAN_VAULT_PATH;
  if (!base) {
    process.stderr.write('wendkeep sync-defs: no vault. Pass --vault <path> or set OBSIDIAN_VAULT_PATH.\n');
    process.exit(2);
  }
  const vaultBase = isAbsolute(base) ? base : resolve(process.cwd(), base);
  const projectPath = resolve(project || process.cwd());
  const r = syncDefs(vaultBase, projectPath);
  process.stdout.write(
    `wendkeep sync-defs: ${r.agents.length} agent(s) -> .codex/agents, ${r.skills.length} skill(s) -> .claude/skills\n`,
  );
  if (r.agents.length) process.stdout.write(`  agents: ${r.agents.join(', ')}\n`);
  if (r.skills.length) process.stdout.write(`  skills: ${r.skills.join(', ')}\n`);
  process.exit(0);
}

// --- seeding (init) ---------------------------------------------------------

const AGENTS_README = `# .brain/agents — versioned custom agent definitions

Canonical, versioned source for your project's custom agents (Codex \`.toml\` format).
\`wendkeep sync-defs\` copies each \`*.toml\` here into \`<project>/.codex/agents/\` so the
agent loads them. Edit here (source of truth); re-run \`wendkeep sync-defs\` after changes.
`;

const EXAMPLE_AGENT = `# Example custom agent (Codex format). Replace with your own.
name = "example-agent"
description = "An example custom agent. Describe when to use it."
developer_instructions = "You are an example agent. State the role, rules, and output format here."
nickname_candidates = [ "example" ]
model = "gpt-5.5"
`;

const SKILLS_README = `# .brain/skills — versioned custom skill definitions

Canonical, versioned source for your project's custom skills (\`<name>/SKILL.md\`).
\`wendkeep sync-defs\` copies each skill folder here into \`<project>/.claude/skills/\` so
the agent loads them. Edit here (source of truth); re-run \`wendkeep sync-defs\` after changes.
`;

const EXAMPLE_SKILL = `---
name: example-skill
description: An example custom skill. Replace with your own — describe the trigger here.
---
Use this skill when ... (describe when it applies).

Rules:
- (what the skill should do)
`;

function writeIfAbsent(path, content, created) {
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf8');
    created.push(path);
  }
}

// Seed the definitions layer in the vault's .brain (folders + README + one example
// each). Non-destructive. Returns the list of paths created.
export function seedDefinitions(brainDir) {
  const created = [];
  const agentsDir = join(brainDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeIfAbsent(join(agentsDir, 'README.md'), AGENTS_README, created);
  writeIfAbsent(join(agentsDir, 'example-agent.toml'), EXAMPLE_AGENT, created);

  const exampleSkillDir = join(brainDir, 'skills', 'example-skill');
  mkdirSync(exampleSkillDir, { recursive: true });
  writeIfAbsent(join(brainDir, 'skills', 'README.md'), SKILLS_README, created);
  writeIfAbsent(join(exampleSkillDir, 'SKILL.md'), EXAMPLE_SKILL, created);

  return created;
}
