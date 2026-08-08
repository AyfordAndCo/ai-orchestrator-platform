import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const requiredFiles = [
  "AGENTS.md",
  "SPEC.md",
  "ROADMAP.md",
  "TASKS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "eslint.config.mjs",
];

const requiredDirectories = [
  "apps/orchestrator-api",
  "apps/orchestrator-worker",
  "apps/dashboard-web",
  "packages/domain",
  "packages/integrations",
  "packages/observability",
  "infra/docker",
  "infra/scripts",
];

test("repository foundation files exist", () => {
  for (const path of requiredFiles) {
    assert.equal(existsSync(path), true, `Missing required file: ${path}`);
  }
});

test("repository foundation directories exist", () => {
  for (const path of requiredDirectories) {
    assert.equal(existsSync(path), true, `Missing required directory: ${path}`);
  }
});
