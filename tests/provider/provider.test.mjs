import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIndependentModels,
  modelCapabilities,
  selectModel,
  selectWorkflowModels,
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

test("selects workflow defaults and task-level model overrides", () => {
  const selected = selectWorkflowModels({
    workflow: {
      implementationDefault: implementation,
      reviewDefault: {
        provider: "gemini",
        model: "review-default",
        capabilities: [modelCapabilities.CODE_REVIEW],
      },
      implementationRequiredCapabilities: [modelCapabilities.CODE_EXECUTION],
      reviewRequiredCapabilities: [modelCapabilities.CODE_REVIEW],
    },
    task: {
      implementation: {
        provider: "openai",
        model: "task-implementation",
        capabilities: [modelCapabilities.CODE_EXECUTION],
      },
    },
  });

  assert.equal(selected.implementation.model, "task-implementation");
  assert.equal(selected.review.model, "review-default");
});

test("rejects a task override that lacks the workflow capability requirement", () => {
  assert.throws(
    () =>
      selectWorkflowModels({
        workflow: {
          implementationDefault: implementation,
          reviewDefault: {
            provider: "gemini",
            model: "review-default",
            capabilities: [modelCapabilities.CODE_REVIEW],
          },
          implementationRequiredCapabilities: [
            modelCapabilities.CODE_EXECUTION,
          ],
          reviewRequiredCapabilities: [modelCapabilities.CODE_REVIEW],
        },
        task: {
          implementation: {
            provider: "openai",
            model: "review-only",
            capabilities: [modelCapabilities.CODE_REVIEW],
          },
        },
      }),
    /does not satisfy required capabilities/,
  );
});

test("rejects workflow routing when selected implementation and review models match", () => {
  assert.throws(
    () =>
      selectWorkflowModels({
        workflow: {
          implementationDefault: implementation,
          reviewDefault: implementation,
          implementationRequiredCapabilities: [
            modelCapabilities.CODE_EXECUTION,
          ],
          reviewRequiredCapabilities: [modelCapabilities.CODE_EXECUTION],
        },
      }),
    /independent provider models/,
  );
});
