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

## Workspace Validation — ALL-313

- [x] Define the workspace validation contract
- [x] Define stable validation error codes
- [x] Implement `PnpmWorkspaceValidator`
- [x] Execute only the trusted `pnpm validate` contract
- [x] Execute validation with `shell: false`
- [x] Restrict execution to the provisioned workspace path
- [x] Capture validation stdout, stderr, exit code, and duration
- [x] Bound captured process output
- [x] Add validation timeout and process termination
- [x] Reject missing, non-directory, and symlink workspace paths
- [x] Preserve typed validation diagnostics at the worker application boundary
- [x] Keep raw process diagnostics out of the domain run state
- [x] Wire the real validator through `executePnpmRun`
- [x] Add temporary-workspace integration coverage
- [x] Add real worker validation success and failure coverage
- [x] Independent review completed and findings resolved
- [x] `pnpm validate` passes with 41 tests

## ALL-314 — Agent Execution Boundary

- [x] Add `EXECUTING` orchestration state.
- [x] Enforce `READY -> EXECUTING -> VALIDATING`.
- [x] Define provider-independent `AgentExecutor` contracts.
- [x] Pass structured run, issue, workspace, and instruction context.
- [x] Protect the provisioned workspace from executor mutation.
- [x] Add stable `AGENT_EXECUTION_FAILED` handling.
- [x] Prevent validation when agent execution fails.
- [x] Preserve workspace for execution-failure diagnostics.
- [x] Preserve repository validation behavior after successful execution.
- [x] Wire `AgentExecutor` into `executePnpmRun`.
- [x] Add execution lifecycle and failure tests.
- [x] Resolve independent review findings.
- [x] Pass full repository validation.

## ALL-315 — Concrete Codex CLI Agent Provider

- [x] Implement `CodexCliAgentExecutor` in the integrations layer.
- [x] Preserve the provider-independent `AgentExecutor` domain boundary.
- [x] Run Codex with fixed adapter-owned arguments and `shell: false`.
- [x] Deliver agent instructions through stdin rather than shell arguments.
- [x] Run Codex with `workspace-write`, ephemeral execution, and no approval prompts.
- [x] Require an absolute trusted Codex executable path.
- [x] Restrict execution to a validated workspace below the configured workspace root.
- [x] Reject missing, non-directory, symbolic-link, and out-of-root workspaces.
- [x] Pass only the explicit Codex environment allowlist.
- [x] Bound stdout and stderr captured from the provider.
- [x] Enforce execution timeout with SIGTERM/SIGKILL process-group termination.
- [x] Expose stable provider launch, execution, timeout, and workspace error codes.
- [x] Compose the concrete Codex executor inside `executePnpmRun`.
- [x] Prevent repository validation when Codex execution fails.
- [x] Preserve real `pnpm validate` execution after successful agent execution.
- [x] Add fake-process coverage without requiring live credentials in CI.
- [x] Add agent-execution tests to the repository test command.
- [x] Complete security-focused independent review and resolve findings.
- [x] Enforce runtime read isolation from unrelated host secrets and privileged resources.
- [x] Complete real-host smoke through the compiled adapter in a disposable repository.
- [x] `pnpm validate` passes with 55 tests.

## Trunk-Based Stacked PR Lifecycle — Planned

The implementation order and decisions for this work are recorded in
`docs/architecture/trunk-based-lifecycle-decisions.md`.

### Phase 1 — Domain and workflow contracts

- [ ] Define `main` as the protected trunk branch.
- [x] Define `Stack`, `PullRequest`, `StackBranch`, and gate result contracts.
- [x] Add `stackId`, `stackOrder`, and `parentBranch` to branch/run context.
- [x] Define the PR lifecycle and merge-readiness gates.
- [x] Define durable phase checkpoints and idempotency keys.
- [ ] Define resumable failure and retry semantics.
- [x] Add domain tests for stack ordering, parent relationships, and gate ordering.

### Phase 2 — Safe execution and validation handoff

- [x] Run validation in a restricted execution environment separate from the host.
- [x] Add Docker Hub digest-pinned container validation for production workers.
- [ ] Bind validation to an immutable candidate tree or commit SHA.
- [ ] Prevent post-validation workspace mutation from changing the candidate.
- [ ] Preserve bounded diagnostics without exposing secrets.
- [ ] Add regression tests for validation isolation and candidate integrity.

### Phase 3 — Provider registry and model routing

- [x] Define provider-neutral execution, review, and capability contracts.
- [ ] Add configurable workflow defaults and per-task model overrides.
- [ ] Add capability requirements and model eligibility checks.
- [x] Add OpenAI-compatible HTTP adapter for Ollama, OpenAI, and OpenRouter.
- [x] Add Gemini adapter and provider-specific request/response mapping.
- [ ] Keep Codex CLI behind the existing secured adapter boundary.
- [ ] Restrict credentials to provider adapters and add configuration tests.
- [ ] Enforce implementation/review provider or model independence.

### Phase 4 — GitHub PR and stacked-branch integration

- [x] Define GitHub adapter contracts for branches, PRs, checks, reviews, and conflicts.
- [ ] Create one PR per run and group PRs by `stackId`.
- [ ] Set each PR base to its recorded `parentBranch`.
- [ ] Track CI, review, QA, and security gate results durably.
- [ ] Add explicit downstream stack update/rebase operation.
- [ ] Attempt automatic conflict resolution in an isolated run.
- [ ] Block and request human resolution when conflict resolution fails.
- [x] Push verified commit SHAs rather than mutable branch refs.
- [ ] Add GitHub integration tests with provider fakes.

### Phase 5 — Recovery, operations, and merge readiness

- [ ] Persist phase checkpoints and make every phase restart idempotent.
- [ ] Resume interrupted runs from the last durable phase.
- [ ] Add reconciliation for branch, PR, CI, and stack state drift.
- [ ] Stop the orchestrator at `MERGE_READY`; delegate merging to GitHub protection/queue.
- [ ] Add observability for stack progress, gate failures, retries, and blocked work.
- [ ] Document operator procedures for retries, conflicts, and manual approvals.
- [ ] Add end-to-end lifecycle tests for single and stacked PRs.
- [ ] Run independent security and workflow review before enabling hosted execution.
