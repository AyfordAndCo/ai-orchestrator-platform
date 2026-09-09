# ai-orchestrator-platform

Production AI orchestration platform with Linear, MongoDB Atlas, GitHub and AI workers.

## Repository standard

See [`docs/governance/REPOSITORY-STRUCTURE-STANDARD.md`](docs/governance/REPOSITORY-STRUCTURE-STANDARD.md) for the shared repository layout and governance baseline used across Ayford projects.

## Agent tooling

This repository vendors the [ECC](https://github.com/allanayford-dev/ECC) agent-harness bundle under `.claude/` (skills, agents, slash commands, coding rules). It is development tooling, not a runtime dependency. See [`docs/tooling/ecc.md`](docs/tooling/ecc.md) for what is included, how to refresh it, and how to opt in to the ECC hook runtime.
