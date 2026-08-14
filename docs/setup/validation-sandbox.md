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
