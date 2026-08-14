import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIndependentModels,
  modelCapabilities,
  selectModel,
} from "../../dist/packages/domain/src/index.js";

const implementation = {
  provider: "ollama",
  model: "qwen-coder",
  capabilities: [modelCapabilities.CODE_EXECUTION],
};

test("selects a task override when it satisfies required capabilities", () => {
  const selected = selectModel({
    workflowDefault: {
      provider: "openai",
      model: "gpt-default",
      capabilities: [modelCapabilities.CODE_EXECUTION],
    },
    taskOverride: implementation,
    requiredCapabilities: [modelCapabilities.CODE_EXECUTION],
  });

  assert.equal(selected.provider, "ollama");
  assert.equal(selected.model, "qwen-coder");
});

test("rejects models missing required capabilities", () => {
  assert.throws(
    () =>
      selectModel({
        workflowDefault: implementation,
        requiredCapabilities: [modelCapabilities.LONG_CONTEXT],
      }),
    /does not satisfy required capabilities/,
  );
});

test("enforces independent implementation and review models", () => {
  assert.throws(() => assertIndependentModels(implementation, implementation));
  assert.doesNotThrow(() =>
    assertIndependentModels(implementation, {
      provider: "gemini",
      model: "reviewer",
      capabilities: [modelCapabilities.CODE_REVIEW],
    }),
  );
});
