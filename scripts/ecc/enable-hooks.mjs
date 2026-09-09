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

/** Every `id` that appears in an ECC `hooks` block, per event. */
function eccHookIds(hooks) {
  const ids = new Set();
  for (const groups of Object.values(hooks ?? {})) {
    for (const group of groups ?? []) {
      if (typeof group?.id === "string") ids.add(group.id);
    }
  }
  return ids;
}

function readExampleHooks() {
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
  return JSON.parse(
    readFileSync(examplePath, "utf8")
      .split(placeholderB64)
      .join(localB64)
      .split(CLAUDE_ROOT_PLACEHOLDER)
      .join(claudeDir.split("\\").join("\\\\")),
  );
}

if (process.argv.includes("--disable")) {
  if (!existsSync(settingsPath)) {
    console.log("[ecc] no .claude/settings.json; nothing to disable");
    process.exit(0);
  }
  const eccIds = eccHookIds(readExampleHooks().hooks);
  backup();
  const current = readJson(settingsPath);
  const userHooks = {};
  for (const [event, groups] of Object.entries(current.hooks ?? {})) {
    const kept = (groups ?? []).filter((group) => !eccIds.has(group?.id));
    if (kept.length > 0) userHooks[event] = kept;
  }
  if (Object.keys(userHooks).length > 0) current.hooks = userHooks;
  else delete current.hooks;

  if (Object.keys(current).length === 0) {
    rmSync(settingsPath, { force: true });
    console.log("[ecc] removed .claude/settings.json (nothing left)");
  } else {
    // Keep every remaining key. A leftover `includeCoAuthoredBy` that `enable`
    // may have added is harmless; deleting a value the contributor set is not.
    writeJson(settingsPath, current);
    console.log("[ecc] removed ECC hook entries; kept your own hooks/settings");
  }
  console.log(`[ecc] previous file saved to ${backupPath}`);
  process.exit(0);
}

const localizedExample = readExampleHooks();
const eccIds = eccHookIds(localizedExample.hooks);

const merged = existsSync(settingsPath) ? readJson(settingsPath) : {};
backup();

// Merge per event: keep the user's groups whose id is not ECC-owned, then
// append the ECC groups. Never discard a user hook.
const mergedHooks = {};
const events = new Set([
  ...Object.keys(merged.hooks ?? {}),
  ...Object.keys(localizedExample.hooks ?? {}),
]);
for (const event of events) {
  const userGroups = (merged.hooks?.[event] ?? []).filter(
    (group) => !eccIds.has(group?.id),
  );
  const eccGroups = localizedExample.hooks?.[event] ?? [];
  mergedHooks[event] = [...userGroups, ...eccGroups];
}
merged.hooks = mergedHooks;
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
