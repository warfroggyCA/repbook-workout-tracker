import { describe, expect, it } from "vitest";
import { canonicalSimulationMutationTables } from "@/services/simulation-mutation-state";

describe("simulation mutation oracle canonicalization", () => {
  it("sorts table names, row order, and nested object keys", () => {
    const left = canonicalSimulationMutationTables({
      z_table: [{ b: 2, a: { d: 4, c: 3 } }, { id: "a" }],
      a_table: [{ value: 1 }],
    });
    const right = canonicalSimulationMutationTables({
      a_table: [{ value: 1 }],
      z_table: [{ id: "a" }, { a: { c: 3, d: 4 }, b: 2 }],
    });
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(Object.keys(left)).toEqual(["a_table", "z_table"]);
  });
});
