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
- **A target repository whose canonical validation needs installed
  dependencies is not currently supported end-to-end.** The validation
  container has no network access and doesn't install dependencies, so
  they would need to be present before validation runs — but
  `GitChangePublisher.inspect()` enumerates ignored paths with a hard
  32KB output cap (`packages/integrations/src/git/git-change-publisher.ts`),
  which any real `node_modules` tree overflows, killing the run right after
  commit. Neither side of that gap is something this CLI can safely work
  around; both need a production-level fix (a dependency-provisioning
  boundary, and/or a larger/streamed inspection buffer) before a typical
  Node repository can complete a real run here.
- A bun or dotnet target additionally needs `--bun-image` / `--dotnet-image`
  (each `sha256`-pinned) — `RepositoryCommandValidator` fails closed on those
  runtimes without a dedicated image, rather than running them in the default
  npm/pnpm/yarn image. Without these flags, only npm/pnpm/yarn targets are
  actually supported by this runner today.
- The target repository must have no active git hooks or git filter
  commands. `GitChangePublisher`'s commit/push never pass `--no-verify`, so
  a repository that points `core.hooksPath` into its tracked tree (as Husky
  does), one with an ordinary hook file already sitting in its default
  hooks directory, or one with a local `filter.<name>.clean`/`smudge`/
  `process` command configured (e.g. by git-lfs) that a tracked
  `.gitattributes` entry can route a file through, would let agent-modified
  code execute with full host privileges during `git add`/`commit`/`push`,
  bypassing both the Codex and validation sandboxes. This runner refuses to
  start if it detects any of these. This is a preflight mitigation, not a
  complete fix — it only catches something already configured before the
  run starts, not something the agent sets up during its own execution. A
  complete fix belongs in `GitChangePublisher` itself.
- The target repository's origin (and any separately configured push URL)
  must not have credentials embedded in an HTTP(S) URL. This runner fails
  closed on that rather than only redacting it from logs: Codex's own
  workspace shares this clone's `.git/config` and has network access, so an
  embedded credential could be read via `git remote get-url origin` and
  misused before the intended push ever happens (see
  [#33](https://github.com/AyfordAndCo/ai-orchestrator-platform/issues/33)).
  An SSH origin's `git@` userinfo is exempt — it's the fixed, non-secret SSH
  login convention, not a credential.
- The raw output printed at the end of a run — Codex's own summary, and any
  validation or git failure's stdout/stderr — is never trusted to be
  secret-free. `redactSecretsDeep` only recognizes known key=value and
  token-prefix shapes, so this runner replaces that specific raw text with a
  length summary instead of printing it, rather than relying on an
  ever-growing regex list. Inspect the workspace or validation container
  directly if you need the actual output.
- A `gh` session authenticated as whichever login is passed as
  `--required-actor` (defaults to `allanayford-dev`) — that is the identity
  `GhCliPullRequestPublisher` requires to own the created PR.
- **`git push` authentication is currently an unsolved prerequisite, not
  something this runner can arrange for you.** `GitChangePublisher` builds a
  completely explicit environment for its `git` subprocesses that excludes
  `SSH_AUTH_SOCK` and any credential-helper configuration, so neither an SSH
  agent nor a normally-configured HTTPS credential helper works here, and it
  exposes no option to inject a credential. An earlier version of this
  runner worked around that by embedding a token in the origin remote URL,
  but that writes the credential into the repository's shared `.git/config`
  — readable by the agent's own workspace, which also has network access —
  before the intended push ever happens. That approach was reverted as a
  real credential-exfiltration risk rather than shipped (see
  [#33](https://github.com/AyfordAndCo/ai-orchestrator-platform/issues/33)).
  Until `GitChangePublisher` supports a safe way to authenticate, only a
  target repository your `git` installation can already push to without
  any of the above (rare in practice) will complete a real run here.

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

| Flag                                                          | Required    | Default                                 | Notes                                                                                                               |
| ------------------------------------------------------------- | ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--repo`                                                      | yes         |                                         | `owner/name`; verified against `--repository-path`'s actual fetch **and** push origin URLs before anything runs     |
| `--repository-path`                                           | yes         |                                         | local clone, must be clean and on `main`                                                                            |
| `--issue`                                                     | yes         |                                         | GitHub issue number to implement                                                                                    |
| `--workspace-root`                                            | yes         |                                         | absolute; the isolated worktree is created under here                                                               |
| `--container-image`                                           | yes         |                                         | must be `sha256`-pinned; used for npm/pnpm/yarn targets                                                             |
| `--bun-image` / `--dotnet-image`                              | conditional |                                         | must be `sha256`-pinned; required for a bun or dotnet target                                                        |
| `--feature-branch`                                            | no          | `agent/issue-<n>-<slug of issue title>` | validated against this repo's `<developer>/<issue-key>-<short-description>` convention and must reference `--issue` |
| `--codex-path` / `--git-path` / `--gh-path` / `--docker-path` | no          | resolved from `PATH`                    | must be absolute, an existing regular file, and executable, if passed                                               |
| `--required-actor`                                            | no          | `allanayford-dev`                       | the `gh` identity that must own the published PR                                                                    |
| `--ci-timeout-ms`                                             | no          | `1200000` (20 min)                      | how long to wait for CI to reach a final state before treating it as failed                                         |
| `--validation-timeout-ms`                                     | no          | `600000` (10 min)                       | how long the canonical validation command may run before treating it as failed                                      |
| `--agent-timeout-ms`                                          | no          | `1200000` (20 min)                      | how long Codex may run before treating the execution as failed                                                      |

Passing `--base-branch`, `--allow-host-validation`, or `--github-token` is
rejected outright with an explanatory error — none of these are supported
(see Prerequisites above).

The run's final state and full result (including which phase failed, if
any) are printed as JSON to stdout.
