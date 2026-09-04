# Validation sandbox

Repository validation can run through the Linux `bubblewrap` boundary by
passing `sandbox` options to `PnpmWorkspaceValidator`.

The sandbox:

- disables network access with a separate network namespace;
- mounts the workspace as the only writable project directory;
- mounts runtime and package-manager files read-only;
- uses a temporary `HOME` and a minimal `PATH`;
- does not inherit the worker environment or provider credentials;
- keeps the existing timeout and process-group termination behavior.

Example configuration:

```ts
const validator = new PnpmWorkspaceValidator({
  sandbox: {
    executablePath: "/usr/bin/bwrap",
    nodeExecutablePath: "/usr/bin/node",
    corepackDirectoryPath: "/opt/corepack",
    corepackCacheDirectoryPath: "/var/cache/corepack",
    pnpmStoreDirectoryPath: "/var/cache/pnpm",
  },
});
```

The runtime and package-manager paths must be provisioned by the worker host
and mounted read-only. Do not point them at a workspace-controlled path.

## Production Docker Hub configuration

Use a digest-pinned image for production validation:

```ts
const validator = new PnpmWorkspaceValidator({
  container: {
    executablePath: "/usr/bin/docker",
    image:
      "docker.io/example/orchestrator-validation@sha256:<immutable-digest>",
    user: "1000:1000",
    memoryLimit: "2g",
    pidsLimit: 256,
  },
});
```

The worker host must authenticate to Docker Hub before starting the worker. The
container receives only the workspace mount and `CI=true`; provider keys and
the Docker socket are never mounted into it.
