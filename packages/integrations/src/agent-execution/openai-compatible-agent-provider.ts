import type {
  AgentProvider,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../../../domain/src/provider/index.js";

const MAX_OUTPUT_BYTES = 1_000_000;

export interface OpenAiCompatibleAgentProviderOptions {
  readonly name: string;
  readonly endpoint: string;
  readonly apiKeyEnvironmentVariable?: string;
  readonly fetchImplementation?: typeof fetch;
}

function requireText(name: string, value: string): string {
  if (value.trim().length === 0)
    throw new RangeError(`${name} must not be empty`);
  return value;
}

function bounded(value: string): string {
  return value.slice(0, MAX_OUTPUT_BYTES);
}

export class OpenAiCompatibleAgentProvider implements AgentProvider {
  readonly name: string;
  readonly #endpoint: string;
  readonly #apiKeyEnvironmentVariable: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleAgentProviderOptions) {
    this.name = requireText("name", options.name);
    this.#endpoint = requireText("endpoint", options.endpoint).replace(
      /\/$/,
      "",
    );
    this.#apiKeyEnvironmentVariable = options.apiKeyEnvironmentVariable;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async execute(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionResult> {
    const apiKey =
      this.#apiKeyEnvironmentVariable === undefined
        ? undefined
        : process.env[this.#apiKeyEnvironmentVariable];
    const headers = new Headers({ "content-type": "application/json" });
    if (apiKey?.trim()) headers.set("authorization", `Bearer ${apiKey}`);

    const response = await this.#fetch(`${this.#endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model.model,
        messages: [{ role: "user", content: request.instruction }],
      }),
    });

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

    const content = (
      parsed as {
        choices?: Array<{ message?: { content?: unknown } }>;
      }
    ).choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`${this.name} response did not contain message content`);
    }

    return { output: bounded(content) };
  }
}
