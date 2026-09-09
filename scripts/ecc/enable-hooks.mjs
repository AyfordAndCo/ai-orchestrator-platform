/* global console */

/**
 * Opt in to the vendored ECC hook runtime.
 *
 * ECC's hook runtime is shipped as `.claude/settings.example.json` with every
 * hook command's ECC root replaced by a placeholder. This script merges the
 * ECC-owned `hooks` block (with the placeholder resolved to this checkout's
 * `.claude/` directory) into a machine-local `.claude/settings.json`
 * (git-ignored), preserving any permissions / MCP / other keys already there.
 *
 * Usage:
 *   node scripts/ecc/enable-hooks.mjs            # merge ECC hooks in
 *   node scripts/ecc/enable-hooks.mjs --disable  # remove only the ECC hooks
 *
 * A `.claude/settings.json.bak` is written before any change. Hooks run a Node
 * process on every tool call and add a config-protection gate; they are entirely
 * optional. See `docs/tooling/ecc.md`.
 */

import { Buffer } from "node:buffer";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CLAUDE_ROOT_PLACEHOLDER } from "./config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const claudeDir = join(repoRoot, ".claude");
const examplePath = join(claudeDir, "settings.example.json");
const settingsPath = join(claudeDir, "settings.json");
const backupPath = `${settingsPath}.bak`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backup() {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, backupPath);
}

if (process.argv.includes("--disable")) {
  if (!existsSync(settingsPath)) {
    console.log("[ecc] no .claude/settings.json; nothing to disable");
    process.exit(0);
  }
  backup();
  const current = readJson(settingsPath);
  delete current.hooks;
  const remaining = Object.keys(current);
  if (
    remaining.length === 0 ||
    (remaining.length === 1 && current.includeCoAuthoredBy !== undefined)
  ) {
    rmSync(settingsPath, { force: true });
    console.log("[ecc] removed .claude/settings.json (was ECC-only)");
  } else {
    writeJson(settingsPath, current);
    console.log(
      "[ecc] removed the ECC `hooks` block; kept your other settings",
    );
  }
  console.log(`[ecc] previous file saved to ${backupPath}`);
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

const localizedExample = JSON.parse(
  readFileSync(examplePath, "utf8")
    .split(placeholderB64)
    .join(localB64)
    .split(CLAUDE_ROOT_PLACEHOLDER)
    .join(claudeDir.split("\\").join("\\\\")),
);

const merged = existsSync(settingsPath) ? readJson(settingsPath) : {};
backup();
merged.hooks = localizedExample.hooks;
if (
  merged.includeCoAuthoredBy === undefined &&
  localizedExample.includeCoAuthoredBy !== undefined
) {
  merged.includeCoAuthoredBy = localizedExample.includeCoAuthoredBy;
}
writeJson(settingsPath, merged);

console.log(
  "[ecc] merged the ECC hooks block into .claude/settings.json (git-ignored).\n" +
    (existsSync(backupPath)
      ? `[ecc] previous file saved to ${backupPath}\n`
      : "") +
    "[ecc] restart Claude Code for the hook runtime to take effect.\n" +
    "[ecc] run `node scripts/ecc/enable-hooks.mjs --disable` to turn it off.",
);
