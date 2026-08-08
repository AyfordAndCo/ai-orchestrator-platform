# Current Tasks

## Repository Foundation

- [x] Define repository agent governance
- [x] Define initial platform specification
- [x] Define phased roadmap
- [x] Create monorepo directory structure
- [x] Configure TypeScript
- [x] Configure formatting
- [x] Configure linting
- [x] Configure foundation tests
- [x] Configure build validation
- [x] Add `pnpm validate`
- [x] Add GitHub Actions validation

## Workspace Provisioning

- [x] Define workspace domain model
- [x] Define workspace provisioning interface
- [x] Implement Git worktree adapter
- [x] Add repository preflight checks
- [x] Add workspace cleanup
- [x] Add integration tests

## Execution State Machine

- [x] Define orchestration run states
- [x] Define orchestration run domain model
- [x] Define guarded state transitions
- [x] Record transition history and timestamps
- [x] Prevent transitions out of terminal states
- [x] Add structured failure metadata
- [x] Enforce chronological run timestamps
- [x] Add worker execution lifecycle
- [x] Integrate the existing `WorkspaceProvisioner` boundary
- [x] Add validation boundary
- [x] Add deterministic clock injection
- [x] Add run-domain tests
- [x] Add worker lifecycle tests
- [x] Add run tests to `pnpm test`
- [x] Pass `pnpm validate`
