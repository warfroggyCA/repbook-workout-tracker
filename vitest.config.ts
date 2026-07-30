import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // V8 coverage plus the full parallel PGlite matrix can make a normally
    // sub-second migrated-database case cross Vitest's 5 s default on macOS.
    testTimeout: 15_000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/postgres-integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "src/ai/**/*.ts",
        "src/app/actions/**/*.ts",
        "src/app/api/**/route.ts",
        "src/components/**/*.tsx",
        "src/engine/**/*.ts",
        "src/lib/**/*.ts",
        "src/services/**/*.ts",
      ],
      exclude: [
        "src/services/workout-test-data.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        branches: 40.1,
        lines: 47.06,
      },
    },
  },
});
