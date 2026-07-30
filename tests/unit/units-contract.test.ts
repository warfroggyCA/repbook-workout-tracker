import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertWeight,
  LOAD_COMPARISON_EPSILON,
  loadsEqual,
  MAX_STORED_LOAD,
  normalizeStoredLoad,
} from "@/lib/units";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
    })
  );
  return files.flat();
}

describe("load-unit conversion contract", () => {
  it("keeps the kg-to-lb factor in one source file", async () => {
    const matches: Array<{ path: string; count: number }> = [];

    for (const path of await sourceFiles("src")) {
      const source = await readFile(path, "utf8");
      const count = source.match(/2\.20462/g)?.length ?? 0;
      if (count > 0) matches.push({ path, count });
    }

    expect(matches).toEqual([{ path: "src/lib/units.ts", count: 1 }]);
  });

  it("compares loads within but not at the half-step boundary", () => {
    expect(LOAD_COMPARISON_EPSILON).toBe(0.005);
    expect(loadsEqual(0, LOAD_COMPARISON_EPSILON - 1e-10)).toBe(true);
    expect(loadsEqual(0, LOAD_COMPARISON_EPSILON)).toBe(false);
    expect(loadsEqual(0, -LOAD_COMPARISON_EPSILON)).toBe(false);
  });

  it("treats only two missing loads as equal", () => {
    expect(loadsEqual(null, null)).toBe(true);
    expect(loadsEqual(undefined, undefined)).toBe(true);
    expect(loadsEqual(null, undefined)).toBe(true);
    expect(loadsEqual(null, 0)).toBe(false);
    expect(loadsEqual(0, undefined)).toBe(false);
  });

  it("absorbs float32 and unit-conversion noise", () => {
    expect(loadsEqual(Math.fround(32.3), 32.3)).toBe(true);
    const pounds = convertWeight(32.3, "kg", "lb");
    expect(loadsEqual(Math.fround(pounds), pounds)).toBe(true);
  });

  it("normalizes durable loads to the numeric(7,2) contract", () => {
    expect(MAX_STORED_LOAD).toBe(99_999.99);
    expect(normalizeStoredLoad(Math.fround(32.3))).toBe(32.3);
    expect(normalizeStoredLoad(32.305)).toBe(32.31);
    expect(normalizeStoredLoad(10.075)).toBe(10.08);
    expect(normalizeStoredLoad(Math.fround(10.075))).toBe(10.08);
    expect(normalizeStoredLoad(1.005)).toBe(1.01);
  });
});
