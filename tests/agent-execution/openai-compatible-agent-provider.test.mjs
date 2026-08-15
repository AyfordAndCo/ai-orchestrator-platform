import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { OpenAiCompatibleAgentProvider } from "../../dist/packages/integrations/src/agent-execution/index.js";

function request() {
  return {
    model: { provider: "ollama", model: "qwen", capabilities: [] },
    instruction: "implement the task",
    context: {},
  };
}

test("sends an OpenAI-compatible request and reads the response", async () => {
  let received;
  const provider = new OpenAiCompatibleAgentProvider({
    name: "ollama",
    endpoint: "http://127.0.0.1:11434/v1/",
    fetchImplementation: async (url, options) => {
      received = { url, options };
      return new globalThis.Response(
        JSON.stringify({ choices: [{ message: { content: "done" } }] }),
        { status: 200 },
      );
    },
  });

  const result = await provider.execute(request());

  assert.equal(result.output, "done");
  assert.equal(received.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.deepEqual(JSON.parse(received.options.body), {
    model: "qwen",
    messages: [{ role: "user", content: "implement the task" }],
  });
});

test("reads hosted API keys only inside the provider adapter", async () => {
  const previous = process.env.TEST_PROVIDER_KEY;
  process.env.TEST_PROVIDER_KEY = "secret-value";
  let authorization;

  try {
    const provider = new OpenAiCompatibleAgentProvider({
      name: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      apiKeyEnvironmentVariable: "TEST_PROVIDER_KEY",
      fetchImplementation: async (_url, options) => {
        authorization = options.headers.get("authorization");
        return new globalThis.Response(
          JSON.stringify({ choices: [{ message: { content: "reviewed" } }] }),
          { status: 200 },
        );
      },
    });

    assert.equal((await provider.execute(request())).output, "reviewed");
    assert.equal(authorization, "Bearer secret-value");
  } finally {
    if (previous === undefined) delete process.env.TEST_PROVIDER_KEY;
    else process.env.TEST_PROVIDER_KEY = previous;
  }
});

test("maps provider HTTP failures and malformed responses", async () => {
  const failed = new OpenAiCompatibleAgentProvider({
    name: "openai",
    endpoint: "https://api.openai.com/v1",
    retryDelayMs: 0,
    fetchImplementation: async () =>
      new globalThis.Response("bad gateway", { status: 502 }),
  });
  await assert.rejects(() => failed.execute(request()), /HTTP 502/);

  const malformed = new OpenAiCompatibleAgentProvider({
    name: "openai",
    endpoint: "https://api.openai.com/v1",
    retryDelayMs: 0,
    fetchImplementation: async () =>
      new globalThis.Response("{}", { status: 200 }),
  });
  await assert.rejects(() => malformed.execute(request()), /message content/);
});
