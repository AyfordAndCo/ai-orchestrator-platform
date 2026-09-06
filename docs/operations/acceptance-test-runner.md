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

## Prerequisites

- A local clone of the target repository, on its base branch, with a clean
  working tree (the workspace provisioner rejects anything else).
- The target repository must already declare a canonical validation
  contract (`scripts.validate` for npm/pnpm/yarn/bun, or a discovered
  `.sln`/`.csproj` for dotnet).
- Codex CLI, `git`, and `gh` on `PATH` (or pass their absolute paths
  explicitly).
- Either:
  - a Docker (or compatible) executable plus a `sha256`-pinned validation
    container image, or
  - `--allow-host-validation`, which runs the target repository's
    (agent-modified) validate script directly on this machine instead of in
    a container. This is a deliberate, explicit opt-in for a one-off test
    run, not the production path.
- A `gh` session authenticated as whichever login is passed as
  `--required-actor` (defaults to `allanayford-dev`) — that is the identity
  `GhCliPullRequestPublisher` requires to own the created PR.

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

Or, for a one-off host-validation run while no pinned image exists yet:

```bash
node dist/apps/orchestrator-worker/src/cli/run-repository-issue.js \
  --repo AyfordAndCo/ayford-wealth-os \
  --repository-path "C:\Users\allan\Github\ayford-wealth-os" \
  --issue 42 \
  --workspace-root "C:\Users\allan\ai-orchestrator-runs" \
  --allow-host-validation
```

| Flag                                        | Required    | Default              | Notes                                                              |
| ------------------------------------------- | ----------- | -------------------- | ------------------------------------------------------------------ |
| `--repo`                                    | yes         |                      | `owner/name`                                                       |
| `--repository-path`                         | yes         |                      | local clone, must be clean and on `--base-branch`                  |
| `--issue`                                   | yes         |                      | GitHub issue number to implement                                   |
| `--workspace-root`                          | yes         |                      | absolute; the isolated worktree is created under here              |
| `--base-branch`                             | no          | `main`               |                                                                    |
| `--feature-branch`                          | no          | `agent/issue-<n>`    |                                                                    |
| `--codex-path` / `--git-path` / `--gh-path` | no          | resolved from `PATH` | must be absolute if passed                                         |
| `--docker-path`                             | conditional |                      | required unless `--allow-host-validation`                          |
| `--container-image`                         | conditional |                      | required unless `--allow-host-validation`; must be `sha256`-pinned |
| `--allow-host-validation`                   | no          | `false`              | see prerequisites above                                            |
| `--required-actor`                          | no          | `allanayford-dev`    | the `gh` identity that must own the published PR                   |

The run's final state and full result (including which phase failed, if
any) are printed as JSON to stdout.
