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
- [x] `pnpm validate` passes with 114 tests when run through the repository's sequential test command.

## Trunk-Based Stacked PR Lifecycle — Planned

The implementation order and decisions for this work are recorded in
`docs/architecture/trunk-based-lifecycle-decisions.md`.

### Phase 1 — Domain and workflow contracts

- [x] Define `main` as the protected trunk branch.
- [x] Define `Stack`, `PullRequest`, `StackBranch`, and gate result contracts.
- [x] Add `stackId`, `stackOrder`, and `parentBranch` to branch/run context.
- [x] Define the PR lifecycle and merge-readiness gates.
- [x] Define durable phase checkpoints and idempotency keys.
- [x] Define resumable failure and retry semantics.
- [x] Add domain tests for stack ordering, parent relationships, and gate ordering.

### Phase 2 — Safe execution and validation handoff

- [x] Run validation in a restricted execution environment separate from the host.
- [x] Add Docker Hub digest-pinned container validation for production workers.
- [x] Add a minimal non-root Docker validation image definition.
- [x] Add a manually gated Docker Hub image publishing workflow.
- [x] Bind validation to an immutable candidate tree or commit SHA.
- [x] Prevent post-validation workspace mutation from changing the candidate.
- [x] Preserve bounded diagnostics without exposing secrets.
- [x] Add regression tests for validation isolation and candidate integrity.

### Phase 3 — Provider registry and model routing

- [x] Define provider-neutral execution, review, and capability contracts.
- [x] Add configurable workflow defaults and per-task model overrides.
- [x] Add capability requirements and model eligibility checks.
- [x] Add OpenAI-compatible HTTP adapter for Ollama, OpenAI, and OpenRouter.
- [x] Add Gemini adapter and provider-specific request/response mapping.
- [x] Keep Codex CLI behind the existing secured adapter boundary.
- [x] Restrict credentials to provider adapters and add configuration tests.
- [x] Enforce implementation/review provider or model independence.

### Phase 4 — GitHub PR and stacked-branch integration

- [x] Define GitHub adapter contracts for branches, PRs, checks, reviews, and conflicts.
- [x] Preserve `runId`, `stackId`, `stackOrder`, and parent-branch metadata on PR records.
- [x] Define durable PR gate records and merge-readiness evaluation.
- [x] Create one PR per run and group PRs by `stackId`.
- [x] Set each PR base to its recorded `parentBranch`.
- [x] Track CI, review, QA, and security gate results durably.
- [x] Add explicit downstream stack update/rebase operation.
- [x] Attempt automatic conflict resolution in an isolated run.
- [x] Block and request human resolution when conflict resolution fails.
- [x] Push verified commit SHAs rather than mutable branch refs.
- [x] Add GitHub integration tests with provider fakes.
- [x] Add independent Gemini and OpenRouter review quorum workflow.

### Phase 5 — Recovery, operations, and merge readiness

- [ ] Persist phase checkpoints and make every phase restart idempotent.
- [ ] Resume interrupted runs from the last durable phase.
- [ ] Add reconciliation for branch, PR, CI, and stack state drift.
- [ ] Stop the orchestrator at `MERGE_READY`; delegate merging to GitHub protection/queue.
- [ ] Add observability for stack progress, gate failures, retries, and blocked work.
- [ ] Document operator procedures for retries, conflicts, and manual approvals.
- [x] Configure conditional human review policy for sensitive changes.
- [ ] Add end-to-end lifecycle tests for single and stacked PRs.
- [ ] Run independent security and workflow review before enabling hosted execution.

### Linear roadmap reconciliation

The following is the current cross-check against Linear (reviewed 2026-08-15):

| Linear issue | Linear status   | Repository coverage                                         | Reconciliation                                                                                                              |
| ------------ | --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ALL-310`    | Needs My Action | Architecture and package boundaries                         | Keep open until the external architecture decisions are explicitly closed; no missing implementation task is inferred here. |
| `ALL-311`    | Done            | Workspace provisioning                                      | Complete; its legacy `develop` wording is historical and must not override this repository's `main` policy.                 |
| `ALL-312`    | Done            | Execution state machine                                     | Complete; lifecycle contracts and tests are present.                                                                        |
| `ALL-313`    | Done            | Restricted workspace validation                             | Complete; validation boundary and regression coverage are present.                                                          |
| `ALL-314`    | Done            | Provider-neutral agent execution                            | Complete; execution boundary and failure behavior are present.                                                              |
| `ALL-315`    | Done            | Codex CLI provider                                          | Complete; secured adapter, isolation, and smoke coverage are present.                                                       |
| `ALL-316`    | Done            | Git change inspection and commit/push                       | Complete; immutable candidate publication is present.                                                                       |
| `ALL-317`    | In Progress     | Phase 4 GitHub PR/CI boundary                               | Implementation underway under the approved `main` policy; Linear's legacy `develop` wording remains superseded by comments. |
| `ALL-318`    | Backlog         | External `gemini-apps` / BodyMetrics foundation             | Separate repository and delivery stream; tracked here only as a dependency of the governance work.                          |
| `ALL-319`    | Backlog         | Governance, trunk workflow, stacked PR policy, and CI gates | Source issue for the cross-repository policy; this repository now records the approved `main` decision and remaining gaps.  |

The approved decision matrix is authoritative for this repository: protected `main`
is the only trunk, every PR base is derived from the recorded parent branch, and
`develop` is rejected. The conflicting `ALL-317` acceptance criteria have been
superseded by the approved policy comments; the issue description should be
formally edited before Phase 4 is closed.

Historical tests that create a temporary `develop` branch remain intentionally
scoped fixtures; they do not define the production branch policy.

### `develop` retirement audit

GitHub reports `main` as the repository default branch and no open PRs targeting
`develop`. The remote refs are nevertheless divergent: `develop` contains seven
commits not present on remote `main`, while the current Phase 1–3 implementation
is still on the local `allan/phase3-model-routing` branch. Do not delete remote
`develop` until the current implementation is promoted through a PR to `main`
and the seven historical commits are confirmed preserved or intentionally
superseded. This is a release/branch-retirement operation, not a Phase 4 code
change.
