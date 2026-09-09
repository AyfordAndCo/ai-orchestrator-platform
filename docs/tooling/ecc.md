# Vendored ECC agent-harness bundle

This repository vendors [ECC](https://github.com/allanayford-dev/ECC) ("Agent
Harness Operating System") under `.claude/` so that any agent or contributor
working **on** `ai-orchestrator-platform` inherits a consistent
plan → test → implement → review → verify → remember workflow (skills, agents,
and coding rules).

ECC is not a runtime dependency of the platform. It is a set of context assets
for AI coding harnesses. The platform's own product code does not import it.

## What is vendored

`.claude/` is **generated**, not hand-edited. It is produced by
`scripts/ecc/refresh.mjs` from a pinned upstream commit
(`scripts/ecc/config.mjs` → `ECC_REF`).

| Path                                 | Contents                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `.claude/agents/`                    | 68 ECC subagent definitions                                                                   |
| `.claude/skills/`                    | Workflow-quality, database, unified-memory, and a curated subset of framework/language skills |
| `.claude/rules/ecc/`                 | `common` + `typescript` coding rules only                                                     |
| `.claude/hooks/`, `.claude/scripts/` | Hook runtime scripts (inactive unless hooks are enabled — see below)                          |
| `.claude/settings.example.json`      | Hook runtime configuration, **disabled by default**                                           |
| `.claude/ecc/refresh-manifest.json`  | Provenance: upstream ref, modules, prune lists                                                |

### Trimmed relative to the upstream `developer` profile

- `framework-language` module is **not** installed wholesale (~60 skills for
  languages this repo does not use). A curated allowlist is re-added — see
  `KEEP_SKILLS` in `scripts/ecc/config.mjs`.
- `orchestration` module (tmux/dmux worktree runners) is **excluded**.
- `rules-core` language packs are pruned to `common` and `typescript`.
- `.claude/commands/` (ECC's "legacy command shims") is **dropped**. Many shims
  run `node scripts/<x>.js` assuming CWD is the ECC plugin root and fail from a
  repository root; ECC's own guidance is skills-first. The skills and agents
  they fronted are kept.

## Hooks are opt-in

The upstream hook runtime bakes an absolute path to `.claude/` into every hook
command, adds a gate that blocks edits to linter/formatter config, and runs a
Node process on every tool call. It is therefore **not** enabled by committing
`.claude/settings.json`. That path is git-ignored.

To opt in for your local checkout:

```bash
pnpm ecc:hooks:enable          # writes a machine-local .claude/settings.json
# restart Claude Code
node scripts/ecc/enable-hooks.mjs --disable   # turn it back off
```

## Updating the bundle

```bash
# 1. Edit scripts/ecc/config.mjs and bump ECC_REF (and ECC_VERSION).
pnpm ecc:refresh              # rebuilds .claude/ from the new ref
# 2. Review the .claude/ diff, then commit it.
```

`pnpm ecc:refresh:check` rebuilds into a temp directory and fails if the
committed `.claude/` no longer matches `ECC_REF` — useful as a drift check.

## MCP connectors

ECC ships an optional `chrome-devtools` MCP connector catalog entry under
`.claude/mcp-configs/`. It is not activated by this repo. If you enable ECC MCP
connectors elsewhere, set `ECC_DISABLED_MCPS="chrome-devtools"` to avoid
duplicate registration.

## Validation

`.claude/` is excluded from `pnpm lint` (`eslint.config.mjs`) and
`pnpm format:check` (`.prettierignore`) because it is third-party generated
content. `pnpm typecheck` and `pnpm architecture:check` only scan `apps/` and
`packages/`, so the bundle does not affect them.
