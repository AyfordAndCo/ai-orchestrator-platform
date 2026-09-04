import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkArchitecture } from "../../scripts/check-architecture.mjs";

async function createFixture(files) {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "orchestrator-architecture-"),
  );

  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const targetPath = join(repositoryRoot, path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, contents, "utf8");
    }),
  );

  return repositoryRoot;
}

test("allows dependencies that point inward through the existing architecture", async (t) => {
  const repositoryRoot = await createFixture({
    "packages/domain/src/work.ts": "export interface Work {}\n",
    "packages/integrations/src/work-adapter.ts":
      'import type { Work } from "../../domain/src/work.js";\nexport class WorkAdapter implements Work {}\n',
    "apps/orchestrator-worker/src/main.ts":
      'import { WorkAdapter } from "../../../packages/integrations/src/work-adapter.js";\nexport const adapter = new WorkAdapter();\n',
  });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  assert.deepEqual(await checkArchitecture(repositoryRoot), []);
});

test("rejects a domain dependency on an outer integration layer", async (t) => {
  const repositoryRoot = await createFixture({
    "packages/domain/src/work.ts":
      'export { WorkAdapter } from "../../integrations/src/work-adapter.js";\n',
    "packages/integrations/src/work-adapter.ts":
      "export class WorkAdapter {}\n",
  });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  assert.deepEqual(await checkArchitecture(repositoryRoot), [
    'packages/domain/src/work.ts: packages/domain cannot depend on packages/integrations via "../../integrations/src/work-adapter.js"',
  ]);
});

test("rejects framework and platform imports from the domain layer", async (t) => {
  const repositoryRoot = await createFixture({
    "packages/domain/src/persistence.ts":
      'import mongoose from "mongoose";\nexport { mongoose };\n',
  });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  assert.deepEqual(await checkArchitecture(repositoryRoot), [
    'packages/domain/src/persistence.ts: domain code cannot import external module "mongoose"',
  ]);
});
