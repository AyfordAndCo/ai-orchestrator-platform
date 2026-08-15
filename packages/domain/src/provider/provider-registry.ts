import type { AgentProvider } from "./provider.js";

export interface AgentProviderRegistry {
  get(provider: string): AgentProvider;
}

function requireProviderName(provider: string): string {
  if (provider.trim().length === 0) {
    throw new TypeError("provider must not be empty");
  }
  return provider;
}

export class ConfiguredAgentProviderRegistry implements AgentProviderRegistry {
  readonly #providers: ReadonlyMap<string, AgentProvider>;

  constructor(providers: readonly AgentProvider[]) {
    const configured = new Map<string, AgentProvider>();
    for (const provider of providers) {
      const name = requireProviderName(provider.name);
      if (configured.has(name)) {
        throw new RangeError(`Provider ${name} is configured more than once`);
      }
      configured.set(name, provider);
    }
    this.#providers = configured;
  }

  get(provider: string): AgentProvider {
    const name = requireProviderName(provider);
    const configured = this.#providers.get(name);
    if (configured === undefined) {
      throw new RangeError(`Provider ${name} is not configured`);
    }
    return configured;
  }
}
