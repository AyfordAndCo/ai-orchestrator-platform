/* global console */

/**
 * Regenerate the vendored ECC bundle under `.claude/`.
 *
 * Usage:
 *   node scripts/ecc/refresh.mjs           # rebuild `.claude/` in place
 *   node scripts/ecc/refresh.mjs --check   # rebuild in a temp dir and fail if it
 *                                           # differs from the committed `.claude/`
 *
 * The bundle is pinned by `scripts/ecc/config.mjs` (`ECC_REF`). Bump that ref and
 * run this script to take an update; commit the resulting `.claude/` diff.
 * See `docs/tooling/ecc.md`.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_ROOT_PLACEHOLDER,
  DROP_PATHS,
  ECC_MODULES,
  ECC_REF,
  ECC_REPO,
  ECC_VERSION,
  KEEP_RULE_LANGS,
  KEEP_SKILLS,
} from "./config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const claudeDir = join(repoRoot, ".claude");
const checkMode = process.argv.includes("--check");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options,
  });
}

function cloneEcc(intoDir) {
  console.log(`[ecc] cloning ${ECC_REPO} @ ${ECC_REF}`);
  run("git", ["init", "--quiet", intoDir], { quiet: true });
  run("git", ["-C", intoDir, "remote", "add", "origin", ECC_REPO], {
    quiet: true,
  });
  try {
    run("git", ["-C", intoDir, "fetch", "--depth", "1", "origin", ECC_REF], {
      quiet: true,
    });
    run("git", ["-C", intoDir, "checkout", "--quiet", "FETCH_HEAD"], {
      quiet: true,
    });
  } catch {
    console.log("[ecc] shallow fetch-by-sha failed; retrying with full fetch");
    run("git", ["-C", intoDir, "fetch", "origin"], { quiet: true });
    run("git", ["-C", intoDir, "checkout", "--quiet", ECC_REF], {
      quiet: true,
    });
  }
  console.log("[ecc] installing installer dependencies");
  run(npmCmd, ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: intoDir,
    // Node >=22 on Windows requires shell:true to spawn `.cmd` shims.
    shell: process.platform === "win32",
  });
}

function installBundle(eccDir, targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true });
  const installer = join(eccDir, "scripts", "install-apply.js");
  run(
    "node",
    [
      installer,
      "--target",
      "claude-project",
      "--modules",
      ECC_MODULES.join(","),
      "--enable-hooks",
    ],
    { cwd: dirname(targetRoot) },
  );
}

function pruneRuleLangs(targetRoot) {
  const rulesDir = join(targetRoot, "rules", "ecc");
  if (!existsSync(rulesDir)) return;
  for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!KEEP_RULE_LANGS.includes(entry.name)) {
      rmSync(join(rulesDir, entry.name), { recursive: true, force: true });
    }
  }
}

function reAddCuratedSkills(eccDir, targetRoot) {
  const skillsTarget = join(targetRoot, "skills");
  for (const skill of KEEP_SKILLS) {
    const from = join(eccDir, "skills", skill);
    if (!existsSync(from)) {
      console.warn(`[ecc] curated skill not found upstream: ${skill}`);
      continue;
    }
    cpSync(from, join(skillsTarget, skill), { recursive: true });
  }
}

function dropPaths(targetRoot) {
  for (const rel of DROP_PATHS) {
    rmSync(join(targetRoot, ...rel.split("/")), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * ECC bakes an absolute path to `.claude/` into every hook command in
 * `settings.json`. Move it to `settings.example.json` with that path replaced by
 * a placeholder so nothing machine-specific is committed. `pnpm ecc:hooks:enable`
 * reverses this for a contributor who opts in.
 */
function settingsToExample(targetRoot) {
  const settingsPath = join(targetRoot, "settings.json");
  if (!existsSync(settingsPath)) {
    throw new Error("expected .claude/settings.json from hooks-runtime module");
  }
  const raw = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  const absClaude = targetRoot;
  const absB64 = Buffer.from(absClaude, "utf8").toString("base64");
  const placeholderB64 = Buffer.from(CLAUDE_ROOT_PLACEHOLDER, "utf8").toString(
    "base64",
  );
  let serialized = JSON.stringify(settings, null, 2);
  // Replace both the base64-encoded and any literal occurrences of the path.
  serialized = serialized.split(absB64).join(placeholderB64);
  serialized = serialized
    .split(JSON.stringify(absClaude).slice(1, -1))
    .join(CLAUDE_ROOT_PLACEHOLDER);
  writeFileSync(
    join(targetRoot, "settings.example.json"),
    `${serialized}\n`,
    "utf8",
  );
  rmSync(settingsPath, { force: true });
}

function writeManifest(targetRoot) {
  const eccStatePath = join(targetRoot, "ecc", "install-state.json");
  rmSync(eccStatePath, { force: true });
  const manifest = {
    generatedBy: "scripts/ecc/refresh.mjs",
    source: { repo: ECC_REPO, ref: ECC_REF, repoVersion: ECC_VERSION },
    modules: ECC_MODULES,
    keepRuleLangs: KEEP_RULE_LANGS,
    curatedSkills: KEEP_SKILLS,
    droppedPaths: DROP_PATHS,
    note: "Generated bundle. Do not hand-edit. Run `pnpm ecc:refresh` to update.",
  };
  writeFileSync(
    join(targetRoot, "ecc", "refresh-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function buildInto(targetRoot) {
  const workDir = mkdtempSync(join(tmpdir(), "ecc-refresh-"));
  try {
    cloneEcc(workDir);
    installBundle(workDir, targetRoot);
    pruneRuleLangs(targetRoot);
    reAddCuratedSkills(workDir, targetRoot);
    dropPaths(targetRoot);
    settingsToExample(targetRoot);
    writeManifest(targetRoot);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function gitStatusPorcelain(pathspec) {
  return run("git", ["-C", repoRoot, "status", "--porcelain", "--", pathspec], {
    quiet: true,
  }).trim();
}

if (checkMode) {
  const tmpTarget = mkdtempSync(join(tmpdir(), "ecc-check-"));
  const tmpClaude = join(tmpTarget, ".claude");
  buildInto(tmpClaude);
  let diff = "";
  try {
    run(
      "git",
      ["--no-pager", "diff", "--no-index", "--stat", claudeDir, tmpClaude],
      { quiet: true },
    );
  } catch (error) {
    diff = `${error.stdout ?? ""}`.trim() || "(differences found)";
  }
  rmSync(tmpTarget, { recursive: true, force: true });
  if (diff) {
    console.error(
      "[ecc] committed .claude/ is stale relative to ECC_REF; run `pnpm ecc:refresh`:",
    );
    console.error(diff);
    process.exit(1);
  }
  console.log("[ecc] committed .claude/ matches ECC_REF");
} else {
  buildInto(claudeDir);
  console.log("\n[ecc] .claude/ rebuilt. Review and commit:\n");
  console.log(gitStatusPorcelain(".claude") || "(no changes)");
}
