/**
 * Pinned configuration for the vendored ECC (Agent Harness Operating System) bundle.
 *
 * The bundle under `.claude/` is generated, not hand-edited. To update it, bump
 * `ECC_REF` here and run `pnpm ecc:refresh`, then commit the resulting `.claude/`
 * diff. See `docs/tooling/ecc.md`.
 */

/** Upstream source repository for ECC. */
export const ECC_REPO = "https://github.com/allanayford-dev/ECC.git";

/**
 * Pinned upstream commit. ECC has no stable release tags we can rely on, so the
 * bundle is pinned to an exact SHA. `repoVersion` is informational only.
 */
export const ECC_REF = "5064474d4d762dc9640234a41617cccb79185cec";
export const ECC_VERSION = "2.2.1";

/**
 * ECC install modules to materialise into `.claude/` for the `claude-project`
 * target. This is the `developer` profile minus:
 *   - `framework-language`  — ~60 skills for languages this repo does not use;
 *                             a curated subset is re-added via `KEEP_SKILLS`.
 *   - `orchestration`       — tmux/dmux worktree runner scripts that do not apply
 *                             to this platform.
 * `hooks-runtime` is included so the hook runtime ships as an opt-in example
 * (`.claude/settings.example.json`); it is never enabled by committing
 * `.claude/settings.json` (that path is git-ignored). See `pnpm ecc:hooks:enable`.
 */
export const ECC_MODULES = [
  "rules-core",
  "agents-core",
  "commands-core",
  "hooks-runtime",
  "platform-configs",
  "workflow-quality",
  "database",
  "skill-unified-memory",
];

/**
 * Language rule packs to keep under `.claude/rules/ecc/`. `rules-core` installs
 * ~19 language trees; this repo is a TypeScript monorepo, so everything except
 * these is pruned after install.
 */
export const KEEP_RULE_LANGS = ["common", "typescript"];

/**
 * Curated `framework-language` skills to re-add after install. Chosen for
 * relevance to a TypeScript / Node / clean-architecture monorepo with a web
 * dashboard app.
 */
export const KEEP_SKILLS = [
  "api-design",
  "backend-patterns",
  "coding-standards",
  "contract-first",
  "hexagonal-architecture",
  "mcp-server-patterns",
  "nestjs-patterns",
  "nextjs-turbopack",
  "vite-patterns",
  "bun-runtime",
  "react-patterns",
  "react-performance",
  "react-testing",
  "frontend-patterns",
  "frontend-design-direction",
  "frontend-a11y",
  "accessibility",
  "design-system",
  "make-interfaces-feel-better",
];

/**
 * Paths to delete after install even though they arrive via a kept module:
 *   - `.agents/`, `.pi/`       — nested bundles for other harnesses (antigravity,
 *                                pi) emitted by `platform-configs`; redundant
 *                                with `.claude/agents` + `.claude/skills`.
 *   - `AGENTS.md`              — ECC's own agent instructions; the repository's
 *                                root `AGENTS.md` is authoritative here.
 *   - `skills/dmux-workflows`  — dmux docs pulled in by `workflow-quality`.
 *   - `scripts/orchestrate-*`  — tmux/dmux worktree runners.
 *   - `commands/multi-workflow`,
 *     `commands/epic-*`,
 *     `commands/project-init`,
 *     `commands/plan-canvas`   — command shims whose documented entrypoints
 *                                (`scripts/orchestrate-worktrees.js`,
 *                                `scripts/github-coordination.js`,
 *                                `scripts/install-apply.js`,
 *                                `scripts/plan-canvas.js`) are not part of this
 *                                trimmed bundle, so the shims would fail with
 *                                MODULE_NOT_FOUND.
 */
export const DROP_PATHS = [
  ".agents",
  ".pi",
  "AGENTS.md",
  "skills/dmux-workflows",
  "scripts/lib/orchestration-session.js",
  "scripts/lib/tmux-worktree-orchestrator.js",
  "scripts/orchestrate-codex-worker.sh",
  "scripts/orchestrate-worktrees.js",
  "scripts/orchestration-status.js",
  "commands/multi-workflow.md",
  "commands/epic-claim.md",
  "commands/epic-decompose.md",
  "commands/epic-publish.md",
  "commands/epic-review.md",
  "commands/epic-sync.md",
  "commands/epic-unblock.md",
  "commands/epic-validate.md",
  "commands/project-init.md",
  "commands/plan-canvas.md",
];

/**
 * Placeholder token written into `.claude/settings.example.json` in place of the
 * absolute path ECC bakes into every hook command. `pnpm ecc:hooks:enable`
 * swaps it for the local absolute path to `.claude/` when a contributor opts in.
 */
export const CLAUDE_ROOT_PLACEHOLDER = "__ECC_CLAUDE_ROOT__";
