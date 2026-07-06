// Renders a neutral, project-templated README for a freshly created wendkeep vault.
// Locale-aware (0.8.1): the structure table + prose follow the vault locale; folder names
// come from the locale so they can never drift from what `wendkeep init` creates.
import { LOCALES, vaultFolders } from '../hooks/locale.mjs';

// Folder descriptions keyed by locale folder KEY (not literal name), per locale.
const DESC = {
  'pt-BR': {
    inbox: 'Notas rápidas, captura sem classificação',
    project: 'Arquitetura, padrões, memória do projeto',
    sessions: 'Uma nota por sessão de trabalho com o agente IA',
    linear: 'Espelho de issues/tarefas do seu tracker (Linear, Jira, GitHub Issues…)',
    decisions: 'Architecture Decision Records (ADRs)',
    bugs: 'Bugs resolvidos com causa raiz documentada',
    learnings: 'Lições extraídas das sessões',
    specs: 'Contrato vivo: capacidades do projeto (requisitos)',
    changes: 'Mudanças em andamento (proposta/design/tarefas/spec-delta)',
    Templates: 'Templates para novas notas',
    '.brain': 'Memória canônica: CORE.md (curado) + DIGEST.md (auto), injetada no SessionStart',
  },
  en: {
    inbox: 'Quick notes, unclassified capture',
    project: 'Architecture, patterns, project memory',
    sessions: 'One note per AI-agent work session',
    linear: 'Mirror of issues/tasks from your tracker (Linear, Jira, GitHub Issues…)',
    decisions: 'Architecture Decision Records (ADRs)',
    bugs: 'Fixed bugs with documented root cause',
    learnings: 'Lessons extracted from sessions',
    specs: 'Living contract: the project capabilities (requirements)',
    changes: 'Changes in flight (proposal/design/tasks/spec-delta)',
    Templates: 'Templates for new notes',
    '.brain': 'Canonical memory: CORE.md (curated) + DIGEST.md (auto), injected at SessionStart',
  },
};

// folder literal -> key, for description lookup.
function keyForFolder(loc, folder) {
  const entry = Object.entries(loc.folders).find(([, name]) => name === folder);
  return entry ? entry[0] : folder; // Templates / .brain fall through as themselves
}

export function renderVaultReadme({ projectName, vaultPath, withMcp = true, locale = 'pt-BR' }) {
  const loc = LOCALES[locale] || LOCALES['pt-BR'];
  const en = loc.id === 'en';
  const desc = DESC[loc.id] || DESC['pt-BR'];
  const name = projectName || (en ? 'project' : 'projeto');

  const rows = vaultFolders(loc).map((f) => `| \`${f}/\` | ${desc[keyForFolder(loc, f)] || (en ? 'Project notes' : 'Notas do projeto')} |`);
  const table = [en ? '| Folder | Contents |' : '| Pasta | Conteúdo |', '| --- | --- |', ...rows].join('\n');

  if (en) {
    const mcpIntro = withMcp ? ', and read/written by the **MCPVault** MCP server' : '';
    const access = [`- **Obsidian:** open this folder with "Open folder as vault" → \`${vaultPath}\``];
    if (withMcp) access.push('- **Agent (MCP):** the `wendkeep-vault` server (MCPVault) points at this vault (set in `.mcp.json`), giving the agent read/write on the notes.');
    access.push('- **Hooks:** `settings.json` calls `npx wendkeep hook <name>`; the vault is located via `OBSIDIAN_VAULT_PATH` (also written by `wendkeep init`).');
    return `# Obsidian vault — ${name}

> Knowledge base of **${name}**, captured automatically by wendkeep from AI coding-agent
> sessions (**Claude Code**, **Codex**) via session hooks${mcpIntro}.

## Structure

${table}

## Access

${access.join('\n')}

## Rules

1. Every relevant work session produces a note in \`${loc.folders.sessions}/\` (automatic, via hooks).
2. Architecture decisions become ADRs in \`${loc.folders.decisions}/\`.
3. Bugs with a root cause go to \`${loc.folders.bugs}/\`; lessons to \`${loc.folders.learnings}/\`.
4. Canonical memory: \`.brain/CORE.md\` (curated) + \`.brain/DIGEST.md\` (auto) — injected at SessionStart.
5. Tags in YAML frontmatter, not inline. Wikilinks \`[[note]]\` to connect notes.

## Notes

- **Locale:** this vault is \`en\` (folder names in English). Set at \`wendkeep init --locale\`; a vault is never renamed after.
- **Versioning:** session notes may contain transcript excerpts — review before committing this vault to a shared repo.
`;
  }

  const mcpIntro = withMcp ? ', e lida/escrita pelo MCP server **MCPVault**' : '';
  const access = [`- **Obsidian:** abra esta pasta com "Open folder as vault" → \`${vaultPath}\``];
  if (withMcp) access.push('- **Agente (MCP):** o servidor `wendkeep-vault` (MCPVault) é apontado para este vault pelo `wendkeep init` (em `.mcp.json`), dando ao agente leitura/escrita das notas.');
  access.push('- **Hooks:** `settings.json` chama `npx wendkeep hook <name>`; o vault é localizado via a env `OBSIDIAN_VAULT_PATH` (também gravada pelo `wendkeep init`).');
  return `# Vault Obsidian — ${name}

> Base de conhecimento de **${name}**, capturada automaticamente pelo wendkeep a
> partir das sessões dos agentes de código IA (**Claude Code** e **Codex**) via
> hooks de sessão${mcpIntro}.

## Estrutura

${table}

## Acesso

${access.join('\n')}

## Regras

1. Toda sessão de trabalho relevante gera nota em \`${loc.folders.sessions}/\` (automático, pelos hooks).
2. Decisões de arquitetura viram ADR em \`${loc.folders.decisions}/\`.
3. Bugs com causa raiz vão para \`${loc.folders.bugs}/\`; lições para \`${loc.folders.learnings}/\`.
4. Memória canônica: \`.brain/CORE.md\` (curado) + \`.brain/DIGEST.md\` (auto) — injetados no SessionStart.
5. Tags em frontmatter YAML, não inline. Wikilinks \`[[nota]]\` para conectar notas.

## Notas

- **Locale:** este vault é \`pt-BR\` (nomes de pasta em português). Definido em \`wendkeep init --locale\`; o vault nunca é renomeado depois.
- **Versionamento:** as notas de sessão podem conter trechos de transcript — avalie antes de commitar este vault em um repositório compartilhado.
`;
}
