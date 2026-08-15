# Trunk-Based Development and Agent Orchestration Decisions

Status: approved planning baseline

Review: 2026-08-15

This decision matrix guides implementation of the next orchestrator lifecycle.
It records the choices made during design review and the constraints that must
remain true as adapters and infrastructure are added.

## Decision matrix

| Area                  | Decision                            | Required behavior                                                                                          | Deferred or rejected alternative                        |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Trunk                 | `main` is the protected trunk       | Every stack ultimately targets `main`; direct pushes and direct merges are prohibited                      | `develop` as the integration trunk                      |
| Branching             | One feature branch per PR           | Branches are created from the current stack parent and remain isolated workspaces                          | Long-lived release branches for feature work            |
| Stack identity        | Explicit orchestrator model         | Persist `stackId`, `stackOrder`, `parentBranch`, and the PR identity for every run                         | Relying only on GitHub PR base fields                   |
| Run granularity       | One run per PR/branch               | A separate run owns implementation, validation, publication, and gates for one branch                      | One run representing an entire stack                    |
| Parent updates        | Explicit operation                  | After a parent merges, downstream branches are updated only by an explicit, auditable operation            | Silent automatic rebases                                |
| Conflicts             | Automatic attempt, then block       | Use an isolated agent attempt; require human resolution if conflicts or validation remain                  | Unattended conflict resolution that can advance a stack |
| Merge authority       | GitHub                              | The orchestrator reaches `MERGE_READY`; branch protection or merge queue performs the merge                | Orchestrator-controlled merges                          |
| Required gates        | Six mandatory gates                 | Local validation, GitHub CI, independent AI review, human review, QA approval, and security scan must pass | Treating local validation as sufficient                 |
| Implementation/review | Independent executions              | Review must use a separate execution and a different provider or model                                     | Self-review by the implementation execution             |
| Provider set          | Pluggable adapters                  | Support Codex CLI, Ollama, OpenAI, Gemini, and OpenRouter; allow configured additional/free models         | Provider-specific domain logic                          |
| Ollama                | Existing local HTTP server          | The orchestrator connects to Ollama and does not manage its process lifecycle                              | Worker starts or stops Ollama                           |
| Model routing         | Task override plus workflow default | Tasks declare capability requirements; configured models are eligible only when they satisfy them          | One globally fixed model                                |
| Credentials           | Adapter-only secret access          | Use environment variables or an approved secrets manager; never pass keys to prompts or coding agents      | Repository-stored keys or broad worker exposure         |
| Validation boundary   | Restricted execution                | Validation runs outside the agent process but inside an equally restricted environment                     | Host-level execution with inherited credentials         |
| Candidate integrity   | Immutable handoff                   | Validate an immutable candidate tree/commit and publish that exact verified SHA                            | Validate, then stage mutable workspace contents         |
| Recovery              | Durable, idempotent phases          | Resume from the last durable checkpoint and safely retry only the interrupted phase                        | Restarting the entire run by default                    |
| GitHub scope          | First integration slice             | Branch/PR creation, CI status, review comments, conflict detection, and explicit downstream updates        | Automatic merge and deployment                          |
| Production            | Human-controlled                    | No direct production deployment authority for agent workloads                                              | Agent-triggered production deployment                   |

## Target lifecycle

```text
QUEUED
  -> PREPARING_WORKSPACE
  -> IMPLEMENTING
  -> CANDIDATE_CREATED
  -> VALIDATING
  -> PR_CREATED
  -> CI_RUNNING
  -> REVIEWING
  -> WAITING_FOR_HUMAN_REVIEW
  -> WAITING_FOR_QA
  -> SECURITY_SCANNING
  -> MERGE_READY
```

Failure, retry, and blocked states are attached to durable phase records rather
than treated as implicit process state. A stack advances only when its parent
relationship and all mandatory gates are satisfied.

## Implementation guardrails

1. Keep domain contracts independent from GitHub, Ollama, and hosted provider SDKs.
2. Treat GitHub state as an external system to reconcile, not as a replacement for
   durable orchestrator state.
3. Never publish a mutable branch ref when a verified commit SHA is available.
4. Do not mark a run complete merely because a branch was pushed.
5. Add tests and security review at each phase boundary; `pnpm validate` remains
   mandatory.

## Linear issue reconciliation

This matrix is the repository-level decision record for the Linear workstream. The
issue status and coverage below are a documentation cross-check, not a replacement
for Linear workflow state.

| Issue     | Current Linear state | Covered by this repository                                                    | Outstanding action                                                                                                |
| --------- | -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ALL-310` | Needs My Action      | Architecture/package-boundary baseline                                        | Close the external architecture decision record when its remaining decisions are accepted.                        |
| `ALL-311` | Done                 | Git worktree provisioning                                                     | No implementation gap; retain legacy branch wording only as historical issue context.                             |
| `ALL-312` | Done                 | Run state machine and worker lifecycle                                        | No implementation gap identified.                                                                                 |
| `ALL-313` | Done                 | Restricted `pnpm validate` boundary                                           | No implementation gap identified.                                                                                 |
| `ALL-314` | Done                 | Provider-independent agent execution                                          | No implementation gap identified.                                                                                 |
| `ALL-315` | Done                 | Secured Codex CLI adapter                                                     | No implementation gap identified.                                                                                 |
| `ALL-316` | Done                 | Candidate inspection, commit, and SHA-pinned push                             | No implementation gap identified.                                                                                 |
| `ALL-317` | In Progress          | Intended Phase 4 PR/CI boundary                                               | Implementation is underway under protected `main`; formally edit the stale issue description before closing.      |
| `ALL-318` | Backlog              | Separate `gemini-apps` repository foundation                                  | Track in that repository; do not add BodyMetrics implementation here.                                             |
| `ALL-319` | Backlog              | Governance requirements reflected in `AGENTS.md`, `TASKS.md`, and this matrix | Use this matrix as the implementation baseline; complete remaining governance artifacts in the owning repository. |

### Binding branch-policy clarification

`main` is the only protected trunk for this repository. `develop` is not an
alternative integration branch. Any Linear issue, acceptance criterion, branch
name, test fixture, or copied workflow text that says otherwise must be treated as
stale context and reconciled before it drives implementation. The PR base for a
stack is the recorded `parentBranch`; for the first branch in a stack that parent
is `main`.

The remote `develop` branch is retained temporarily because it still contains
history not present on remote `main`. Its deletion is permitted only after the
current implementation is promoted to `main` and that history is explicitly
verified as preserved or intentionally superseded.
