#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const progressLogPath = resolve(repositoryRoot, ".agents/progress-log.md");
const allowedStatuses = new Set([
  "completed",
  "in_progress",
  "blocked",
  "follow_up",
]);
const requiredFields = [
  "issue",
  "status",
  "scope",
  "evidence",
  "repository-updates",
  "linear-update",
  "follow-up",
];

function readArguments(argumentsList) {
  const values = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--") {
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const key = argument.slice(2);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    values[key] = value;
    index += 1;
  }

  return values;
}

function gitValue(command, fallback) {
  try {
    return (
      execFileSync("git", command, {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
}

function validate(values) {
  for (const field of requiredFields) {
    if (!values[field]) {
      throw new Error(`Required field missing: --${field}`);
    }
    if (values[field].includes("\n") || values[field].includes("\r")) {
      throw new Error(`Use a single-line value for --${field}`);
    }
  }

  if (!allowedStatuses.has(values.status)) {
    throw new Error(`Unsupported status: ${values.status}`);
  }
}

function usage() {
  return `Usage:
  pnpm progress:record -- \
    --issue ALL-000 \
    --status completed|in_progress|blocked|follow_up \
    --scope "short task scope" \
    --evidence "validation command and result" \
    --repository-updates "files or task rows updated" \
    --linear-update "status/comment or pending action" \
    --follow-up "None or explicit blocker/follow-up"`;
}

try {
  const values = readArguments(process.argv.slice(2));
  validate(values);

  const date = new Date().toISOString().slice(0, 10);
  const branch = gitValue(["branch", "--show-current"], "unknown-branch");
  const commit = gitValue(["rev-parse", "--short", "HEAD"], "unknown-commit");
  const entry = `\n## ${date} — ${values.issue} — ${values.status}\n\n- Scope: ${values.scope}\n- Evidence: ${values.evidence}\n- Repository updates: ${values["repository-updates"]}\n- Linear update: ${values["linear-update"]}\n- Branch/commit: ${branch} @ ${commit}\n- Follow-up/blocker: ${values["follow-up"]}\n`;

  await appendFile(progressLogPath, entry, "utf8");
  process.stdout.write(
    `Recorded ${values.issue} (${values.status}) in .agents/progress-log.md\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
