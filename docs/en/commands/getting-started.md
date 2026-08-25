# Installation and first use

**English** · [Português](../../pt-BR/commands/getting-started.md)

## Purpose

Install WendKeep, bind the project to the correct vault, and enable capture, memory, and skills
without overwriting existing configuration.

## When to use

Use `wendkeep init` for the first installation and `wendkeep sync` after updating the package.

## When not to use

Do not run `init --force` as a generic repair for memory or unreadable configuration. Run
`wendkeep doctor` first and follow the repair command it reports.

## Prerequisites

- Node.js 18 or newer.
- A local project and write access to the vault.
- Claude Code or Codex; Obsidian is optional at runtime and recommended for graph navigation.

## Syntax

```bash
npm install --save-dev wendkeep
npx wendkeep init [options]
npx wendkeep sync [--project <root>] [--vault <vault>] [--profile <profile>] [--yes] [--vscode-worktree-tasks]
```

## Options and exit codes

- `--vault <path>` selects the vault; otherwise the local `.wendkeep.json` binding wins.
- `--project <path>` selects the project root.
- `--profile <OFF|FLOW|GUIDE|GOVERN|ASSURE>` selects the Operating Profile; new installs use
  `GOVERN`, re-init/sync without the flag preserves the existing choice, and `OFF` is never inferred.
- `--no-mcp`, `--no-colors`, and `--no-companions` disable optional integrations.
- `--vscode-worktree-tasks` creates local VS Code tasks without overwriting `tasks.json`; `sync`
  forwards the same flag to its `init` stage.
- `--companions <csv>` explicitly enables companion integrations.
- `--yes` accepts non-interactive defaults; `--force` refreshes managed blocks only.
- Exit `0` means setup/sync completed. Any other exit identifies the failed stage. `sync` stops at
  `init`, `sync-defs`, or `doctor` instead of hiding the error.
- `sync` does not pre-resolve the Vault before `init`: an invalid binding fails closed at that first
  stage, and only a validated binding reaches `sync-defs` and `doctor`; no global fallback is used.

## Examples

First installation in the current project:

```bash
npm install --save-dev wendkeep
npx wendkeep init --profile GOVERN --no-companions
```

Later update:

```bash
npm install --save-dev wendkeep@latest
npx wendkeep sync --yes
```

With pnpm, query the published version and reuse the returned value. Minimum-release-age policies
may keep `latest` silently behind; in a monorepo, `-w` targets the workspace root:

```powershell
$version = pnpm view wendkeep version
pnpm add -D -w "wendkeep@$version" --config.minimumReleaseAge=0
pnpm install --update-checksums --config.minimumReleaseAge=0
pnpm exec wendkeep sync --yes
```

Do not edit only the version or integrity in `pnpm-lock.yaml`. If
`ERR_PNPM_TARBALL_INTEGRITY` appears after a manual edit, run `pnpm store prune` and repeat
`pnpm install --update-checksums --config.minimumReleaseAge=0`. The
`minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` is also manual and must use the
version returned by `pnpm view`; pnpm does not write that line.

## Expected result

The project receives `.wendkeep.json`, managed Claude/Codex hooks, skill definitions, and an
initialized vault. Existing files are merged or preserved, and the selected vault is printed.

When MCP is enabled, `init` preserves existing properties and servers in `.mcp.json` and adds
`wendkeep-vault`. If the existing JSON is invalid, the original file remains byte-for-byte intact
and the reconciled proposal is written to `.mcp.json.new`. Since version 0.65, this composition is
owned by the private MCP kernel. The entry runs the installed semantic server through
`npx --no-install wendkeep mcp serve --vault <vault>`, with no dynamic `@latest` download. See
[Native MCP](mcp.md) for tools, gates, limits, and client snippets.

Pure rules that project Claude/Codex hooks and interpret envelopes, transcripts, usage, and
identity belong to the private `@wendkeep/integrations` workspace. Historical facades retain
stdin/stdout, environment, filesystem, Vault, and registry effects. This adds no commands or flags,
changes neither hooks nor sessions, and requires no Vault, configuration, path, or schema migration.
MCP and Integrations remain sibling adapters with no dependency between them, and the direction
remains `cli/mcp/integrations/pi → Harness → Vault`. Everything stays inside the single published
`wendkeep` package; there is no public `wendkeep/integrations` surface. Pi is the next modular phase.

## Common errors and diagnosis

- Wrong vault: inspect `.wendkeep.json` and run `wendkeep doctor --vault <path>`.
- Codex hooks do not run: approve **Hooks need review** on the next startup.
- `defs stale`: run `wendkeep sync-defs --reseed`, then restart the agents.
- `sync` stops at doctor: read the failing section; do not retry with `--force` blindly.

## Next steps

Continue with [maintenance and diagnostics](maintenance-and-diagnostics.md),
[sessions and import](sessions-and-import.md), and [shared memory](memory.md).
