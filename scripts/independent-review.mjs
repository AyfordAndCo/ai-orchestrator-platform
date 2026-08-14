import { execFileSync } from "node:child_process";
import process from "node:process";

import {
  GeminiAgentProvider,
  OpenAiCompatibleAgentProvider,
} from "../dist/packages/integrations/src/agent-execution/index.js";
import { hasApprovalVerdict } from "./independent-review-policy.mjs";

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
const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" });

const prompt = `You are an independent code reviewer. Review only the candidate diff below.
Do not assume the implementer's intent and do not modify files. Look for correctness,
security, reliability, test gaps, and violations of the repository lifecycle decisions.
The worker intentionally preserves provisioned workspaces after failures for diagnostics;
do not report missing automatic cleanup as a defect unless it destroys candidate integrity.
The repository manifest below is authoritative: do not claim a file is missing if it is
listed there. The diff is intentionally bounded, so never infer that a file is truncated
or incomplete from the excerpt ending. The repository's deterministic format, lint,
typecheck, test, and build checks have already passed; do not report syntax or type
errors without concrete contradictory evidence in the supplied diff.
Return exactly one first line of either VERDICT: APPROVE or VERDICT: REQUEST_CHANGES,
then at most five concise findings with file and line references. APPROVE is allowed
only when no actionable issue remains. Do not include chain-of-thought or a review plan.

Tracked file manifest:
${trackedFiles}

Candidate diff:
${diff.slice(0, 120_000)}`;

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
if (!hasApprovalVerdict(result.output)) {
  process.exitCode = 1;
}
