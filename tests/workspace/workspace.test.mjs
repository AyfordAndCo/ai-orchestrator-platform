import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkspaceProvisioningError,
  workspaceErrorCodes,
} from "../../dist/packages/domain/src/workspace/index.js";

import { provisionWorkspace } from "../../dist/apps/orchestrator-worker/src/workspace/provision-workspace.js";

test("workspace provisioning errors expose stable error codes", () => {
  const error = new WorkspaceProvisioningError(
    workspaceErrorCodes.WORKSPACE_CONFLICT,
    "Workspace already exists",
  );

  assert.equal(error.name, "WorkspaceProvisioningError");
  assert.equal(error.code, workspaceErrorCodes.WORKSPACE_CONFLICT);
  assert.equal(error.message, "Workspace already exists");
});

test("worker provisioning use case delegates to WorkspaceProvisioner", async () => {
  const request = {
    issueId: "ALL-TEST-001",
    repositoryPath: "/source",
    baseBranch: "develop",
    featureBranch: "allan/all-test-001",
    workspacePath: "/workspace",
  };

  const expectedWorkspace = { ...request };

  let receivedRequest;

  const provisioner = {
    async preflight() {},

    async create(value) {
      receivedRequest = value;
      return expectedWorkspace;
    },

    async remove() {},
  };

  const result = await provisionWorkspace(provisioner, request);

  assert.deepEqual(receivedRequest, request);
  assert.deepEqual(result, expectedWorkspace);
});
