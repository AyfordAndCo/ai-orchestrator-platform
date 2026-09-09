/* global console */

/**
 * Opt in to the vendored ECC hook runtime.
 *
 * ECC's hook runtime is shipped as `.claude/settings.example.json` with every
 * hook command's ECC root replaced by a placeholder. This script writes a
 * machine-local `.claude/settings.json` (git-ignored) with the placeholder
 * resolved to this checkout's `.claude/` directory.
 *
 * Usage:
 *   node scripts/ecc/enable-hooks.mjs            # write .claude/settings.json
 *   node scripts/ecc/enable-hooks.mjs --disable  # remove .claude/settings.json
 *
 * Hooks run a Node process on every tool call and add a config-protection gate;
 * they are entirely optional. See `docs/tooling/ecc.md`.
 */

import { Buffer } from "node:buffer";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CLAUDE_ROOT_PLACEHOLDER } from "./config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const claudeDir = join(repoRoot, ".claude");
const examplePath = join(claudeDir, "settings.example.json");
const settingsPath = join(claudeDir, "settings.json");

if (process.argv.includes("--disable")) {
  rmSync(settingsPath, { force: true });
  console.log("[ecc] removed .claude/settings.json (hooks disabled)");
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error(
    "[ecc] .claude/settings.example.json not found; run `pnpm ecc:refresh` first",
  );
  process.exit(1);
}

const placeholderB64 = Buffer.from(CLAUDE_ROOT_PLACEHOLDER, "utf8").toString(
  "base64",
);
const localB64 = Buffer.from(claudeDir, "utf8").toString("base64");

const localized = readFileSync(examplePath, "utf8")
  .split(placeholderB64)
  .join(localB64)
  .split(CLAUDE_ROOT_PLACEHOLDER)
  .join(claudeDir.split("\\").join("\\\\"));

writeFileSync(settingsPath, localized, "utf8");
console.log(
  "[ecc] wrote .claude/settings.json for this checkout (git-ignored).\n" +
    "[ecc] restart Claude Code for the hook runtime to take effect.\n" +
    "[ecc] run `node scripts/ecc/enable-hooks.mjs --disable` to turn it off.",
);
