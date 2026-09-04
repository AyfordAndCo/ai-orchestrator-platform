# GitHub Copilot Instructions

Apply the canonical engineering standards from `AyfordAndCo/engineering-standards` (https://github.com/AyfordAndCo/engineering-standards) and this repository's `AGENTS.md`.

Preserve Clean Architecture boundaries, keep business logic out of transport/UI/persistence layers, add meaningful tests, avoid unnecessary abstractions, and do not bypass linting, type checking, architecture checks, security checks, tests, CI, or review requirements.

`pnpm validate` is the repository's required mechanical quality gate.
