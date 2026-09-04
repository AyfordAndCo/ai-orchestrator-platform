# AGENTS.md

## Purpose

This file defines mandatory rules for any human, AI agent, coding agent,
or automation harness making changes to this repository.

The workflow is tool-independent. No AI provider or coding harness may bypass
these rules.

## Organization Engineering Standards

Organization-wide engineering standards are defined in `AyfordAndCo/engineering-standards`:
https://github.com/AyfordAndCo/engineering-standards

All work must comply with the relevant Clean Code, Clean Architecture, Testing,
Security, Agent Compliance, and Definition of Done standards. The repository-specific
rules in this file extend those standards and may be stricter. Do not weaken linting,
type checks, tests, security checks, or architecture rules merely to make validation pass.

## Sources of Truth

Use these sources in order for product and implementation requirements:

1. The assigned issue and its acceptance criteria
2. SPEC.md
3. ROADMAP.md
4. TASKS.md
5. Existing repository architecture and tests

All sources remain subject to the mandatory organization engineering standards.
If requirements conflict, stop and report the conflict rather than guessing.

## Branching

The default development branch is `develop`.

Never make direct changes to:

- `develop`
- `main`

Each issue must use:

- one isolated workspace
- one feature branch
- one pull request

Branch names should follow:

`<developer>/<issue-key>-<short-description>`

Example:

`allan/all-350-repository-foundation`

## Scope

Implement only the assigned issue.

Do not:

- make unrelated refactors
- change unrelated features
- introduce speculative functionality
- change infrastructure unrelated to the issue

Prefer the smallest change that fully satisfies the acceptance criteria.

## Validation

Before work can be considered complete, run:

`pnpm validate`

Validation must pass before committing completed work.

Do not:

- disable failing tests
- weaken validation rules to obtain a pass
- ignore TypeScript errors
- bypass CI checks

Never claim validation passed unless it was actually executed successfully.

## Testing

Changes must include appropriate tests.

Bug fixes should include regression coverage where practical.

Tests must validate behaviour rather than implementation details where possible.

## Git

Agents may:

- modify their assigned workspace
- create commits on their assigned feature branch
- push their assigned feature branch
- create or update their pull request

Agents may not:

- push directly to `develop`
- push directly to `main`
- force push protected branches
- merge their own pull request
- bypass required reviews or CI checks

## Pull Requests

Each pull request must include:

- issue reference
- implementation summary
- validation performed
- test evidence
- known limitations or follow-up work

The latest commit must pass CI before approval.

## Review

Implementation and review should use independent contexts.

An implementation agent must not act as the final reviewer of its own work.

Review findings must be assessed and resolved before final approval.

## Security

Never:

- commit credentials
- expose secrets in logs
- copy production secrets into agent prompts
- modify production systems unless explicitly assigned
- grant an agent unrestricted host access
- grant unnecessary Docker or root privileges

Secrets must be provided through approved runtime mechanisms.

## Production

Agents must not deploy directly to production.

Production deployment requires the repository's approved deployment workflow
and required human approval gates.

## Definition of Done

Work is complete only when:

- acceptance criteria are satisfied
- implementation is scoped to the assigned issue
- tests are present where required
- `pnpm validate` passes
- changes are committed
- changes are pushed
- pull request is created
- required CI checks pass
- review findings are resolved
- human approval is obtained where required
