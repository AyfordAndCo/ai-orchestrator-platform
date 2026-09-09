import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // `.claude/` is the vendored ECC agent-harness bundle (generated; see
    // docs/tooling/ecc.md). It is third-party and not subject to repo lint rules.
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".claude/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
);
