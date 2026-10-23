import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "@repbook/next-eslint/core-web-vitals";
import nextTs from "@repbook/next-eslint/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "output/**",
    "next-env.d.ts",
    // Agent worktrees contain full repo copies incl. their own node_modules.
    ".claude/**",
    // MIT upstream compiled tooling; authored boundary is covered by focused tests.
    "tools/next-eslint/config/**",
    "tools/next-eslint/plugin/**",
  ]),
]);

export default eslintConfig;
