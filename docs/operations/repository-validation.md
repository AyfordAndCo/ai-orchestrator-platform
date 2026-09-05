# Repository validation adapters

The worker must validate the immutable candidate independently after agent
execution. `executeRepositoryRun` detects the repository's declared validation
contract and invokes it through `RepositoryCommandValidator`.

Supported contracts are:

- `package.json` with `scripts.validate`, using pnpm, npm, yarn, or bun;
- a solution or project file (`.sln`/`.csproj`), using `dotnet test`.

Production execution requires a pinned container image. The container has no
network, a read-only root filesystem, dropped Linux capabilities, a non-root
user, and only the provisioned workspace mounted. Host execution is available
only through the explicit test process seam; it is never the default.

The worker also allowlists environment variables, bounds and sanitizes output,
escalates timeout termination, and rechecks candidate `HEAD` on every exit path.
