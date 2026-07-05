// Renders a neutral, project-templated README for a freshly created wendkeep vault.
// The structure table is derived from VAULT_FOLDERS so it can never drift from the
// folders `wendkeep init` actually creates.
import { VAULT_FOLDERS } from './taxonomy.mjs';

const FOLDER_DESCRIPTIONS = {
  '00-Inbox': 'Notas rápidas, captura sem classificação',
  '01-Projeto': 'Arquitetura, padrões, memória do projeto',
  '02-Sessões': 'Uma nota por sessão de trabalho com o agente IA',
  '03-Linear': 'Espelho de issues/tarefas do seu tracker (Linear, Jira, GitHub Issues…)',
  '04-Decisões': 'Architecture Decision Records (ADRs)',
  '05-Bugs': 'Bugs resolvidos com causa raiz documentada',
  '06-Aprendizados': 'Lições extraídas das sessões',
  Templates: 'Templates para novas notas',
  '.brain': 'Memória canônica: CORE.md (curado) + DIGEST.md (auto), injetada no SessionStart',
};

function structureTable() {
  const rows = VAULT_FOLDERS.map((f) => {
    const desc = FOLDER_DESCRIPTIONS[f] || 'Notas do projeto';
    return `| \`${f}/\` | ${desc} |`;
  });
  return ['| Pasta | Conteúdo |', '| --- | --- |', ...rows].join('\n');
}

export function renderVaultReadme({ projectName, vaultPath, withMcp = true }) {
  const name = projectName || 'projeto';
  const mcpIntro = withMcp ? ', e lida/escrita pelo MCP server **MCPVault**' : '';

  const access = [
    `- **Obsidian:** abra esta pasta com "Open folder as vault" → \`${vaultPath}\``,
  ];
  if (withMcp) {
    access.push(
      '- **Agente (MCP):** o servidor `wendkeep-vault` (MCPVault) é apontado para este vault\n' +
        '  pelo `wendkeep init` (em `.mcp.json`), dando ao agente leitura/escrita das notas.',
    );
  }
  access.push(
    '- **Hooks:** `settings.json` chama `npx wendkeep hook <name>`; o vault é localizado\n' +
      '  via a env `OBSIDIAN_VAULT_PATH` (também gravada pelo `wendkeep init`).',
  );

  return `# Vault Obsidian — ${name}

> Base de conhecimento de **${name}**, capturada automaticamente pelo wendkeep a
> partir das sessões dos agentes de código IA (**Claude Code** e **Codex**) via
> hooks de sessão${mcpIntro}.

## Estrutura

${structureTable()}

## Acesso

${access.join('\n')}

## Regras

1. Toda sessão de trabalho relevante gera nota em \`02-Sessões/\` (automático, pelos hooks).
2. Decisões de arquitetura viram ADR em \`04-Decisões/\`.
3. Bugs com causa raiz vão para \`05-Bugs/\`; lições para \`06-Aprendizados/\`.
4. Memória canônica: \`.brain/CORE.md\` (curado) + \`.brain/DIGEST.md\` (auto) — injetados no SessionStart.
5. Tags em frontmatter YAML, não inline.
6. Wikilinks \`[[nota]]\` para conectar notas entre si.

## Notas

- **Idioma das pastas:** os nomes são PT-BR (limitação conhecida; i18n no roadmap do wendkeep).
- **Versionamento:** as notas de sessão podem conter trechos de transcript — avalie
  antes de commitar este vault em um repositório compartilhado.
`;
}
