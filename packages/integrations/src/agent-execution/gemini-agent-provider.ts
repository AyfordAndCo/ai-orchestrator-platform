import type {
  AgentProvider,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../../../domain/src/provider/index.js";

const MAX_OUTPUT_BYTES = 1_000_000;

function bounded(value: string): string {
  return value.slice(0, MAX_OUTPUT_BYTES);
}

export interface GeminiAgentProviderOptions {
  readonly name?: string;
  readonly endpoint: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly fetchImplementation?: typeof fetch;
}

function required(name: string, value: string): string {
  if (value.trim().length === 0)
    throw new RangeError(`${name} must not be empty`);
  return value;
}

export class GeminiAgentProvider implements AgentProvider {
  readonly name: string;
  readonly #endpoint: string;
  readonly #apiKeyEnvironmentVariable: string;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiAgentProviderOptions) {
    this.name = options.name?.trim() || "gemini";
    this.#endpoint = required("endpoint", options.endpoint).replace(/\/$/, "");
    this.#apiKeyEnvironmentVariable = required(
      "apiKeyEnvironmentVariable",
      options.apiKeyEnvironmentVariable,
    );
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionResult> {
    const key = process.env[this.#apiKeyEnvironmentVariable];
    if (!key?.trim()) throw new Error(`${this.name} API key is unavailable`);

    const url = new URL(
      `${this.#endpoint}/v1beta/models/${encodeURIComponent(request.model.model)}:generateContent`,
    );
    url.searchParams.set("key", key);
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.instruction }] }],
        }),
      });
      if (
        response.ok ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        attempt >= 4
      )
        break;
      await new Promise((resolve) =>
        setTimeout(resolve, 3_000 * (attempt + 1)),
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `${this.name} request failed with HTTP ${response.status}: ${bounded(body)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`${this.name} returned invalid JSON`, { cause: error });
    }

    const parts = (
      parsed as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      }
    ).candidates?.[0]?.content?.parts;
    const output = parts
      ?.map((part) => part.text)
      .filter((text): text is string => typeof text === "string")
      .join("");
    if (!output) throw new Error(`${this.name} response did not contain text`);
    return { output: bounded(output) };
  }
}
