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

/**
 * Node treats `.claude/**` `.js` files as ES modules because the repository
 * `package.json` declares `"type": "module"`. The vendored ECC hook runtime is
 * CommonJS, so drop a package boundary that scopes `.claude/` to CommonJS.
 */
function writeCjsBoundary(targetRoot) {
  writeFileSync(
    join(targetRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "ecc-vendored-bundle",
        private: true,
        type: "commonjs",
        description:
          "Generated by scripts/ecc/refresh.mjs. Scopes the vendored ECC hook runtime to CommonJS; not a workspace package.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Git-ignored, machine-local paths under `.claude/` that an in-place refresh must not destroy. */
const LOCAL_STATE_PATHS = Object.freeze([
  "settings.json",
  "settings.json.bak",
  "settings.local.json",
  "scheduled_tasks.lock",
  "worktrees",
  join("ecc", "state"),
  join("ecc", "sessions"),
  join("ecc", "memory"),
  join("ecc", "logs"),
]);

function stashLocalState(targetRoot, stashDir) {
  for (const rel of LOCAL_STATE_PATHS) {
    const from = join(targetRoot, rel);
    if (existsSync(from))
      cpSync(from, join(stashDir, rel), { recursive: true });
  }
}

function restoreLocalState(targetRoot, stashDir) {
  for (const rel of LOCAL_STATE_PATHS) {
    const from = join(stashDir, rel);
    if (existsSync(from))
      cpSync(from, join(targetRoot, rel), { recursive: true });
  }
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
  const stashDir = mkdtempSync(join(tmpdir(), "ecc-localstate-"));
  let stashed = false;
  try {
    stashLocalState(targetRoot, stashDir);
    stashed = true;
    cloneEcc(workDir);
    installBundle(workDir, targetRoot);
    pruneRuleLangs(targetRoot);
    reAddCuratedSkills(workDir, targetRoot);
    dropPaths(targetRoot);
    settingsToExample(targetRoot);
    writeCjsBoundary(targetRoot);
    writeManifest(targetRoot);
  } finally {
    // Always put the machine-local state back, even when the rebuild threw
    // after `installBundle` removed the previous `.claude/`.
    if (stashed) {
      try {
        restoreLocalState(targetRoot, stashDir);
      } catch (error) {
        console.warn(`[ecc] could not restore local state: ${error.message}`);
      }
    }
    rmSync(workDir, { recursive: true, force: true });
    rmSync(stashDir, { recursive: true, force: true });
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

  // Compare only git-tracked files under `.claude/`, so a contributor's
  // machine-local `.claude/settings.json` and ignored runtime state
  // (logs/sessions/state) do not register as drift.
  const tracked = run(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", ".claude"],
    { quiet: true },
  )
    .split("\0")
    .filter((line) => line.length > 0);

  // Read committed content from the git blob (not the working tree) so a
  // Windows autocrlf checkout does not read back as drift.
  const committedBlob = (relFromRepo) =>
    run("git", ["-C", repoRoot, "show", `HEAD:${relFromRepo}`], {
      quiet: true,
      encoding: "buffer",
    });
  const normalize = (buf) => buf.toString("utf8").replace(/\r\n/g, "\n");

  const drift = [];
  const seen = new Set();
  for (const relFromRepo of tracked) {
    const relFromClaude = relFromRepo.replace(/^\.claude\//, "");
    seen.add(relFromClaude);
    const rebuilt = join(tmpClaude, ...relFromClaude.split("/"));
    if (!existsSync(rebuilt)) {
      drift.push(`- removed upstream: ${relFromRepo}`);
    } else if (
      normalize(committedBlob(relFromRepo)) !== normalize(readFileSync(rebuilt))
    ) {
      drift.push(`- changed: ${relFromRepo}`);
    }
  }

  function walkNew(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkNew(join(dir, entry.name), rel);
      } else if (!seen.has(rel)) {
        drift.push(`- new upstream: .claude/${rel}`);
      }
    }
  }
  walkNew(tmpClaude, "");

  rmSync(tmpTarget, { recursive: true, force: true });
  if (drift.length > 0) {
    console.error(
      "[ecc] committed .claude/ is stale relative to ECC_REF; run `pnpm ecc:refresh`:",
    );
    console.error(drift.join("\n"));
    process.exit(1);
  }
  console.log("[ecc] committed .claude/ matches ECC_REF");
} else {
  buildInto(claudeDir);
  console.log("\n[ecc] .claude/ rebuilt. Review and commit:\n");
  console.log(gitStatusPorcelain(".claude") || "(no changes)");
}
