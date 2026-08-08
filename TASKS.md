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
