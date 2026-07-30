import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const guardedRoots = [
  "src/app/(simulation)",
  "src/components/simulation",
  "src/lib",
];

const prohibitedImportFragments = [
  "@/app/actions/",
  "@/services/session-lifecycle",
  "@/services/progression-jobs",
  "@/services/live-coaching",
  "@/services/coaching",
  "@/services/digest",
  "@/services/export",
  "@/lib/workout-set-outbox",
  "@/lib/equipment-selection-outbox",
  "@/lib/occurrence-mutation-outbox",
  "@/lib/live-coach-",
  "@/lib/rest-timer",
  "@/lib/active-workout-measurements",
  "@/lib/export-request",
  "@/components/session/session-runner",
  "@/components/session/exercise-card",
  "@/components/session/workout-status-bar",
  "@/components/session/workout-set-outbox-sync",
  "@/components/session/occurrence-mutation-outbox-sync",
  "@/components/session/live-coach-",
  "@/components/coach/",
  "@/components/archive/",
  "@/components/recovery/",
];

const prohibitedImportPatterns = [
  /@\/services\/archive(?:["'/]|$)/,
  /@\/services\/snapshots?(?:-|["'/]|$)/,
  /@\/services\/recovery(?:-|["'/]|$)/,
];

const prohibitedStorageFragments = [
  "workout-set-outbox",
  "equipment-selection-outbox",
  "occurrence-mutation-outbox",
  "equipment-selection-acknowledgements",
  "workout-command-sequence",
  "rest-timer",
  "active-workout-measurements",
  "live-coach-outbox",
];

function importSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g,
    ),
    (match) => match[1],
  );
}

function prohibitedImportViolations(source: string): string[] {
  return importSpecifiers(source).filter(
    (specifier) =>
      prohibitedImportFragments.some((value) => specifier.includes(value)) ||
      prohibitedImportPatterns.some((pattern) => pattern.test(specifier)),
  );
}

function prohibitedStorageViolations(source: string): string[] {
  return prohibitedStorageFragments.filter((value) => source.includes(value));
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesBelow(path)
      : /\.(ts|tsx)$/.test(entry.name)
        ? [path]
        : [];
  });
}

function guardedFiles() {
  return guardedRoots.flatMap((directory) => {
    const absolute = join(root, directory);
    if (directory === "src/lib") {
      return readdirSync(absolute, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && /^workout-simulation.*\.ts$/.test(entry.name),
        )
        .map((entry) => join(absolute, entry.name));
    }
    return filesBelow(absolute);
  });
}

describe("simulation structural isolation", () => {
  it("cannot import live workout mutation, queue, timer, Coach, or recovery writers", () => {
    const violations = guardedFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return prohibitedImportViolations(source)
        .map((value) => `${relative(root, file)} imports ${value}`);
    });
    expect(violations).toEqual([]);
  });

  it("cannot name or reuse a live workout local-storage contract", () => {
    const violations = guardedFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return prohibitedStorageViolations(source)
        .map((value) => `${relative(root, file)} references ${value}`);
    });
    expect(violations).toEqual([]);
  });

  it("does not import the database from a simulation client component", () => {
    const violations = guardedFiles().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const isClient = /^\s*["']use client["'];?/m.test(source);
      return isClient && /from ["']@\/db(?:["'/])/.test(source)
        ? [relative(root, file)]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("recognizes static, dynamic, and CommonJS prohibited imports", () => {
    const sample = [
      `import { logSet } from "@/app/actions/workouts";`,
      `const archive = await import("@/services/archive");`,
      `const snapshots = require("@/services/snapshots");`,
      `import { SessionRunner } from "@/components/session/session-runner";`,
    ].join("\n");

    expect(prohibitedImportViolations(sample)).toEqual([
      "@/app/actions/workouts",
      "@/services/archive",
      "@/services/snapshots",
      "@/components/session/session-runner",
    ]);
  });

  it("recognizes every explicitly forbidden live-storage family", () => {
    for (const fragment of prohibitedStorageFragments) {
      expect(prohibitedStorageViolations(`workout-tracker:${fragment}:v1`)).toContain(
        fragment,
      );
    }
  });
});
