# Claude Code Instructions

Follow the canonical organization engineering standards in `AyfordAndCo/engineering-standards`: https://github.com/AyfordAndCo/engineering-standards

Also follow this repository's `AGENTS.md`, which contains stricter project-specific workflow, branching, validation, review, security, and Definition of Done requirements.

Do not disable lint rules, weaken tests, bypass type checks, ignore architecture rules, bypass CI, or introduce competing architecture merely to obtain a passing result.

Run `pnpm validate` before completion. Never claim validation passed unless it was actually executed successfully.
