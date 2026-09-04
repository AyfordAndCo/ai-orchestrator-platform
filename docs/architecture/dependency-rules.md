# Clean Architecture dependency rules

The repository enforces its existing dependency direction through
`pnpm architecture:check`, which is part of the canonical `pnpm validate`
command used locally and in GitHub Actions.

The allowed source dependencies are:

- `packages/domain` may depend only on itself and cannot import external
  framework or platform modules.
- `packages/integrations` may depend on `packages/domain` and itself.
- `packages/observability` may depend on `packages/domain` and itself.
- `apps` are composition roots and may depend on the packages, while imports
  between separate apps remain outside the enforced package-layer boundary.

The checker covers static imports, re-exports, and dynamic imports in TypeScript
source files. A violation fails validation and therefore fails the repository's
required CI check.
