import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentHarnessProvisioningError,
  agentHarnessErrorCodes,
} from "../../dist/packages/domain/src/agent-harness/index.js";

test("exposes stable agent-harness error codes", () => {
  assert.deepEqual(Object.keys(agentHarnessErrorCodes).sort(), [
    "HARNESS_BUNDLE_UNAVAILABLE",
    "HARNESS_TARGET_UNSUPPORTED",
    "HARNESS_WORKSPACE_REJECTED",
    "HARNESS_WRITE_FAILED",
  ]);

  for (const [key, value] of Object.entries(agentHarnessErrorCodes)) {
    assert.equal(key, value);
  }
});

test("AgentHarnessProvisioningError carries a typed code", () => {
  const error = new AgentHarnessProvisioningError(
    agentHarnessErrorCodes.HARNESS_TARGET_UNSUPPORTED,
    "no provisioner for target",
  );

  assert.ok(error instanceof Error);
  assert.equal(error.name, "AgentHarnessProvisioningError");
  assert.equal(error.code, "HARNESS_TARGET_UNSUPPORTED");
  assert.equal(error.message, "no provisioner for target");
});

test("the harness contract is reachable from the domain root entrypoint", async () => {
  const domain = await import("../../dist/packages/domain/src/index.js");
  assert.equal(typeof domain.AgentHarnessProvisioningError, "function");
  assert.equal(
    domain.agentHarnessErrorCodes.HARNESS_BUNDLE_UNAVAILABLE,
    "HARNESS_BUNDLE_UNAVAILABLE",
  );
});
