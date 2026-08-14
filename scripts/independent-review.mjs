import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  GeminiAgentProvider,
  OpenAiCompatibleAgentProvider,
} from "../dist/packages/integrations/src/agent-execution/index.js";

const providerName = process.env.REVIEW_PROVIDER;
const modelName = process.env.REVIEW_MODEL;
if (!providerName || !modelName) {
  throw new Error("REVIEW_PROVIDER and REVIEW_MODEL are required");
}

const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "origin/main...HEAD"],
  {
    encoding: "utf8",
    maxBuffer: 2_000_000,
  },
);

const prompt = `You are an independent code reviewer. Review only the candidate diff below.
Do not assume the implementer's intent and do not modify files. Look for correctness,
security, reliability, test gaps, and violations of the repository lifecycle decisions.
Return exactly one first line of either VERDICT: APPROVE or VERDICT: REQUEST_CHANGES,
then concise findings with file and line references. APPROVE is allowed only when no
actionable issue remains.

Candidate diff:
${diff.slice(0, 1_800_000)}`;

const model = {
  provider: providerName,
  model: modelName,
  capabilities: ["CODE_REVIEW", "LONG_CONTEXT"],
};

const provider =
  providerName === "gemini"
    ? new GeminiAgentProvider({
        endpoint:
          process.env.GEMINI_ENDPOINT ??
          "https://generativelanguage.googleapis.com",
        apiKeyEnvironmentVariable: "GEMINI_API_KEY",
      })
    : new OpenAiCompatibleAgentProvider({
        name: providerName,
        endpoint:
          process.env.OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1",
        apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
      });

const result = await provider.execute({
  model,
  instruction: prompt,
  context: { repository: process.env.GITHUB_REPOSITORY ?? "unknown" },
});

process.stdout.write(`${result.output}\n`);
if (!/^VERDICT:\s*APPROVE\s*$/im.test(result.output)) {
  process.exitCode = 1;
}
