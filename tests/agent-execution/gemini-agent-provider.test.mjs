import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { GeminiAgentProvider } from "../../dist/packages/integrations/src/agent-execution/index.js";

test("sends Gemini content requests and parses text parts", async () => {
  const previous = process.env.TEST_GEMINI_KEY;
  process.env.TEST_GEMINI_KEY = "gemini-secret";
  let received;

  try {
    const provider = new GeminiAgentProvider({
      endpoint: "https://generativelanguage.googleapis.com",
      apiKeyEnvironmentVariable: "TEST_GEMINI_KEY",
      fetchImplementation: async (url, options) => {
        received = { url: String(url), options };
        return new globalThis.Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "hello" }, { text: " world" }] } },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const result = await provider.execute({
      model: {
        provider: "gemini",
        model: "gemini-2.5-flash",
        capabilities: [],
      },
      instruction: "say hello",
      context: {},
    });

    assert.equal(result.output, "hello world");
    assert.match(received.url, /models\/gemini-2\.5-flash:generateContent/);
    assert.match(received.url, /key=gemini-secret/);
    assert.deepEqual(JSON.parse(received.options.body), {
      contents: [{ parts: [{ text: "say hello" }] }],
    });
  } finally {
    if (previous === undefined) delete process.env.TEST_GEMINI_KEY;
    else process.env.TEST_GEMINI_KEY = previous;
  }
});

test("rejects missing Gemini credentials and malformed responses", async () => {
  const previous = process.env.TEST_GEMINI_KEY;
  delete process.env.TEST_GEMINI_KEY;
  try {
    const provider = new GeminiAgentProvider({
      endpoint: "https://example.test",
      apiKeyEnvironmentVariable: "TEST_GEMINI_KEY",
      fetchImplementation: async () =>
        new globalThis.Response("{}", { status: 200 }),
    });
    await assert.rejects(
      () =>
        provider.execute({
          model: { provider: "gemini", model: "model", capabilities: [] },
          instruction: "test",
          context: {},
        }),
      /API key is unavailable/,
    );
  } finally {
    if (previous !== undefined) process.env.TEST_GEMINI_KEY = previous;
  }
});
