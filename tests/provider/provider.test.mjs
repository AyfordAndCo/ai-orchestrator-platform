import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIndependentModels,
  ConfiguredAgentProviderRegistry,
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

test("selects per-task implementation and review overrides", () => {
  const selected = selectWorkflowModels(
    {
      models: [
        implementation,
        {
          provider: "openai",
          model: "gpt-task",
          capabilities: [modelCapabilities.CODE_EXECUTION],
        },
        {
          provider: "openrouter",
          model: "review-task",
          capabilities: [modelCapabilities.CODE_REVIEW],
        },
        {
          provider: "gemini",
          model: "review-default",
          capabilities: [modelCapabilities.CODE_REVIEW],
        },
      ],
      defaults: {
        implementation,
        review: {
          provider: "gemini",
          model: "review-default",
          capabilities: [modelCapabilities.CODE_REVIEW],
        },
      },
      taskOverrides: {
        "task-123": {
          implementation: {
            provider: "openai",
            model: "gpt-task",
            capabilities: [modelCapabilities.CODE_EXECUTION],
          },
          review: {
            provider: "openrouter",
            model: "review-task",
            capabilities: [modelCapabilities.CODE_REVIEW],
          },
        },
      },
    },
    "task-123",
    {
      implementation: [modelCapabilities.CODE_EXECUTION],
      review: [modelCapabilities.CODE_REVIEW],
    },
  );

  assert.equal(selected.implementation.model, "gpt-task");
  assert.equal(selected.review.model, "review-task");
});

test("falls back to workflow defaults when a task has no overrides", () => {
  const selected = selectWorkflowModels(
    {
      models: [
        implementation,
        {
          provider: "gemini",
          model: "review-default",
          capabilities: [modelCapabilities.CODE_REVIEW],
        },
      ],
      defaults: {
        implementation,
        review: {
          provider: "gemini",
          model: "review-default",
          capabilities: [modelCapabilities.CODE_REVIEW],
        },
      },
    },
    "task-123",
    {
      implementation: [modelCapabilities.CODE_EXECUTION],
      review: [modelCapabilities.CODE_REVIEW],
    },
  );

  assert.equal(selected.implementation.model, "qwen-coder");
  assert.equal(selected.review.model, "review-default");
});

test("rejects a task override that violates model independence", () => {
  assert.throws(
    () =>
      selectWorkflowModels(
        {
          models: [
            {
              ...implementation,
              capabilities: [
                modelCapabilities.CODE_EXECUTION,
                modelCapabilities.CODE_REVIEW,
              ],
            },
            {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          ],
          defaults: {
            implementation,
            review: {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          },
          taskOverrides: {
            "task-123": {
              review: {
                provider: "ollama",
                model: "qwen-coder",
                capabilities: [modelCapabilities.CODE_REVIEW],
              },
            },
          },
        },
        "task-123",
        {
          implementation: [modelCapabilities.CODE_EXECUTION],
          review: [modelCapabilities.CODE_REVIEW],
        },
      ),
    /independent provider models/,
  );
});

test("rejects models that are not in the configured catalog", () => {
  assert.throws(
    () =>
      selectWorkflowModels(
        {
          models: [
            implementation,
            {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          ],
          defaults: {
            implementation,
            review: {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          },
          taskOverrides: {
            "task-123": {
              implementation: {
                provider: "openai",
                model: "unapproved",
                capabilities: [modelCapabilities.CODE_EXECUTION],
              },
            },
          },
        },
        "task-123",
        {
          implementation: [modelCapabilities.CODE_EXECUTION],
          review: [modelCapabilities.CODE_REVIEW],
        },
      ),
    /is not configured/,
  );
});

test("uses catalog capabilities instead of override claims", () => {
  assert.throws(
    () =>
      selectWorkflowModels(
        {
          models: [
            {
              provider: "ollama",
              model: "qwen-coder",
              capabilities: [],
            },
            {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          ],
          defaults: {
            implementation: {
              provider: "ollama",
              model: "qwen-coder",
              capabilities: [modelCapabilities.CODE_EXECUTION],
            },
            review: {
              provider: "gemini",
              model: "review-default",
              capabilities: [modelCapabilities.CODE_REVIEW],
            },
          },
        },
        "task-123",
        {
          implementation: [modelCapabilities.CODE_EXECUTION],
          review: [modelCapabilities.CODE_REVIEW],
        },
      ),
    /does not satisfy required capabilities/,
  );
});

test("resolves only explicitly configured providers", () => {
  const ollama = { name: "ollama", execute: async () => ({ output: "" }) };
  const gemini = { name: "gemini", execute: async () => ({ output: "" }) };
  const registry = new ConfiguredAgentProviderRegistry([ollama, gemini]);

  assert.equal(registry.get("ollama"), ollama);
  assert.throws(() => registry.get("openai"), /is not configured/);
});

test("rejects duplicate provider registrations", () => {
  const provider = { name: "ollama", execute: async () => ({ output: "" }) };

  assert.throws(
    () => new ConfiguredAgentProviderRegistry([provider, provider]),
    /configured more than once/,
  );
});
