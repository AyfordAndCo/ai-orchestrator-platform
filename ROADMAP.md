# Roadmap

## Phase 0 — Repository Foundation

Establish:

- repository governance
- monorepo workspace structure
- TypeScript configuration
- linting
- formatting
- testing
- build validation
- GitHub Actions validation

Exit criteria:

`pnpm validate` passes locally and in GitHub Actions.

## Phase 1 — Workspace Provisioning

Implement:

- repository registration
- Git fetch
- isolated Git worktree creation
- feature branch creation
- workspace cleanup
- workspace preflight checks

Exit criteria:

A task can safely create and remove an isolated workspace without modifying
the source repository.

## Phase 2 — Execution State Machine

Implement:

- agent run entity
- state transitions
- execution lifecycle
- failure states
- persistence contracts

Exit criteria:

A run can progress through the initial lifecycle deterministically.

## Phase 3 — Agent Provider Abstraction

Implement:

- coding agent interface
- provider adapter contracts
- execution request contracts
- execution result contracts

Exit criteria:

The orchestrator can invoke an agent without domain code depending on a
specific AI provider.

## Phase 4 — GitHub Workflow

Implement:

- commit
- push
- pull request creation
- CI status retrieval
- branch status validation

Exit criteria:

A validated implementation can produce a pull request and report CI status.

## Phase 5 — Independent Review and QA

Implement:

- independent review execution
- review findings
- remediation loop
- QA approval gate

Exit criteria:

A pull request cannot progress to ready-for-merge until review and QA gates pass.

## Phase 6 — Linear Integration

Implement:

- issue ingestion
- acceptance criteria mapping
- orchestration status synchronization

Exit criteria:

Linear issues can drive controlled orchestrator runs.

## Phase 7 — Controlled Deployment

Implement deployment coordination only after all previous gates are proven.

Automatic production deployment is not part of the initial implementation.
