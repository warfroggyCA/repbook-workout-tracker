import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EST_ONE_RM_MAX_REPS,
  estimateOneRepMax,
} from "@/lib/one-rep-max";

const root = resolve(import.meta.dirname, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("estimated one-rep-max contract", () => {
  it("defines Epley only across the inclusive 1 through 12 rep boundary", () => {
    expect(EST_ONE_RM_MAX_REPS).toBe(12);
    expect(estimateOneRepMax(100, 1)).toBeCloseTo(103.333333);
    expect(estimateOneRepMax(100, 12)).toBe(140);
    expect(estimateOneRepMax(100, 0)).toBeNull();
    expect(estimateOneRepMax(100, 13)).toBeNull();
    expect(estimateOneRepMax(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps every SQL Epley replica next to the shared boundary name", () => {
    const files = sourceFiles(resolve(root, "src")).filter((file) =>
      /\.(?:ts|tsx)$/.test(file)
    );
    const sqlReplicas = new Set([
      resolve(root, "src/services/dashboard.ts"),
      resolve(root, "src/services/history-report.ts"),
    ]);
    const arithmetic = /\(1\s*\+\s*[\w.]+\s*\/\s*30(?:\.0)?\)/g;
    const unannotated: string[] = [];

    for (const file of files) {
      const lines = readFileSync(resolve(root, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!arithmetic.test(line)) return;
        arithmetic.lastIndex = 0;
        if (file === resolve(root, "src/lib/one-rep-max.ts")) return;
        const nearby = lines
          .slice(Math.max(0, index - 3), index + 4)
          .join("\n");
        if (
          !sqlReplicas.has(file) ||
          !nearby.includes("EST_ONE_RM_MAX_REPS")
        ) {
          unannotated.push(`${file.replace(`${root}/`, "")}:${index + 1}`);
        }
      });
    }

    expect(unannotated).toEqual([]);
  });

  it("does not persist estimated one-rep-max values in database rows", () => {
    const schemaFiles = sourceFiles(resolve(root, "src/db/schema"));
    const storedEstimate = /est_?1rm|estimated_one_rep/i;
    expect(
      schemaFiles
        .filter((file) => storedEstimate.test(readFileSync(file, "utf8")))
        .map((file) => file.replace(`${root}/`, ""))
    ).toEqual([]);
  });
});
