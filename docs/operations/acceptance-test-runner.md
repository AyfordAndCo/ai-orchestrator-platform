# Manual acceptance-test runner

`apps/orchestrator-worker/src/cli/run-repository-issue.ts` takes one real
GitHub issue through the full `executeRepositoryRun` pipeline against one
real target repository: workspace provisioning, Codex execution,
stack-aware validation, git inspect/commit/push, PR publication, and CI
observation.

It exists to answer issue #27's question — do the already built and tested
primitives actually work together against a real repository — with no
manual implementation editing in between. It does **not** implement work
intake (the issue is named explicitly on the command line, not discovered
by polling for a `Ready` label), and it is not a production trigger.

Validation always runs inside the configured container. AGENTS.md forbids
granting an agent unrestricted host access, so there is no host-execution
escape hatch here: if you don't yet have a pinned validation image, publish
one before running this.

## Prerequisites

- A local clone of the target repository, on `main`, with a clean working
  tree (the workspace provisioner rejects anything else). The base branch is
  always `main` — `GhCliPullRequestPublisher` only publishes against `main`,
  so a target repository whose base branch is something else isn't
  supported by this runner.
- The target repository must already declare a canonical validation
  contract (`scripts.validate` for npm/pnpm/yarn/bun, or a discovered
  `.sln`/`.csproj` for dotnet).
- Codex CLI, `git`, `gh`, and a Docker (or compatible) executable on `PATH`
  (or pass their absolute paths explicitly), plus a `sha256`-pinned
  validation container image.
- A `gh` session authenticated as whichever login is passed as
  `--required-actor` (defaults to `allanayford-dev`) — that is the identity
  `GhCliPullRequestPublisher` requires to own the created PR.

Note: workspace provisioning (`GitWorkspaceProvisioner`) always invokes
`git` via `PATH` regardless of `--git-path` — that option only configures
the git executable used later, for the commit/push boundary
(`GitChangePublisher`). If `git` isn't on `PATH`, provisioning fails before
that boundary is reached.

## Usage

```bash
pnpm build
node dist/apps/orchestrator-worker/src/cli/run-repository-issue.js \
  --repo AyfordAndCo/ayford-wealth-os \
  --repository-path "C:\Users\allan\Github\ayford-wealth-os" \
  --issue 42 \
  --workspace-root "C:\Users\allan\ai-orchestrator-runs" \
  --docker-path "C:\Program Files\Docker\Docker\resources\bin\docker.exe" \
  --container-image "docker.io/ayfordandco/ai-orchestrator-platform-validation@sha256:<digest>"
```

| Flag                                                          | Required | Default              | Notes                                                                       |
| ------------------------------------------------------------- | -------- | -------------------- | --------------------------------------------------------------------------- |
| `--repo`                                                      | yes      |                      | `owner/name`                                                                |
| `--repository-path`                                           | yes      |                      | local clone, must be clean and on `main`                                    |
| `--issue`                                                     | yes      |                      | GitHub issue number to implement                                            |
| `--workspace-root`                                            | yes      |                      | absolute; the isolated worktree is created under here                       |
| `--container-image`                                           | yes      |                      | must be `sha256`-pinned                                                     |
| `--feature-branch`                                            | no       | `agent/issue-<n>`    |                                                                             |
| `--codex-path` / `--git-path` / `--gh-path` / `--docker-path` | no       | resolved from `PATH` | must be absolute if passed                                                  |
| `--required-actor`                                            | no       | `allanayford-dev`    | the `gh` identity that must own the published PR                            |
| `--ci-timeout-ms`                                             | no       | `1200000` (20 min)   | how long to wait for CI to reach a final state before treating it as failed |

Passing `--base-branch` or `--allow-host-validation` is rejected outright
with an explanatory error — neither is supported (see Prerequisites above).

The run's final state and full result (including which phase failed, if
any) are printed as JSON to stdout.
