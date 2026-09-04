# Repository Structure and Governance Standard

This document defines the shared repository layout and operating rules used to keep Ayford projects aligned.

## Purpose

The goal is consistency, not sameness. Each repository may have product-specific code, but the shape of the repository, the delivery rules, and the documentation surface should feel familiar across projects.

## Baseline repo types

### 1. Monorepo product platform

Use this layout when a repository contains multiple deployable apps or shared packages.

Expected top-level directories:

- `apps/` for deployable applications
- `packages/` for reusable libraries and shared domain code
- `docs/` for decisions, runbooks, and architecture notes
- `tests/` for repo-level integration or cross-cutting checks
- `scripts/` for build and maintenance helpers
- `infra/` for infrastructure definitions and deployment assets
- `.github/` for CI and repo automation

Expected top-level files:

- `README.md`
- `AGENTS.md`
- `package.json`
- `pnpm-workspace.yaml` when using pnpm workspaces
- lockfile for the chosen package manager
- shared TypeScript or compiler config files
- lint and formatter config
- environment examples for each runtime role

### 2. Single service repository

Use this layout when the repository centers on one runtime with optional side assets.

Expected top-level directories:

- `src/` for runtime code
- `docs/` for deployment, operations, and architecture notes
- `scripts/` for maintenance helpers
- `tests/` when repo-level tests are not colocated with source
- optional UI or static asset directories only when they are part of the service

Expected top-level files:

- `README.md`
- `AGENTS.md` when agent governance applies
- `package.json`
- lockfile for the chosen package manager
- runtime environment examples
- build and validation scripts

## Shared naming rules

- Use neutral product and infrastructure names in package, workspace, and project identifiers.
- Keep deployable boundaries explicit in folder names and script names.
- Name environment files by runtime role, not by internal implementation detail.
- Prefer one clear naming convention per repository.
- Avoid personal-name branding in package or workspace identifiers.

## Validation contract

Every repository should expose a single command that runs the full local validation chain.

Preferred shape:

- `lint`
- `typecheck`
- `test`
- `build`
- `validate`

The `validate` command should be the shortest path to a release-ready check, and it should be the command referenced in agent instructions and CI where practical.

## Governance contract

### Branching

- Keep one long-lived trunk branch per repository.
- Use short-lived feature branches for all implementation work.
- Do not commit directly to the trunk branch.
- Use stacked branches only when a dependency between PRs is real.

### Pull requests

- Keep PRs small and independently reviewable.
- Reference the tracking issue or task in every PR.
- Document validation performed in the PR description.
- Record any known limitations or follow-up work.

### Sensitive changes

Require explicit human approval before merging or deploying changes involving:

- authentication
- secrets or credentials
- production infrastructure
- data migrations
- security policy
- branch protection or CI policy
- environment configuration that can affect production behavior

### Agent behavior

- Agents should implement only the assigned scope.
- Agents should prefer the smallest change that satisfies the acceptance criteria.
- Agents should not weaken tests, validation, or policy to get a pass.
- Agents should not deploy directly to production.

## Documentation contract

Each repository should keep the following easy to find:

- current repository purpose
- current delivery sequence or task list
- architecture or decision records
- deployment instructions when the repo ships to an environment
- any repo-specific operating constraints for agents

If a repository has both product and platform concerns, document the product first and the platform second.

## Application of this standard

This standard is intended to align Ayford repositories such as:

- `ai-orchestrator-platform`
- `gemini-apps`
- other future Ayford project repositories

When a repository already has a stricter rule, the stricter rule wins for that repository.
