import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateSemanticFixture,
  normalizeSemanticOutcome,
  type SemanticFixture,
  V2_CONTRACT_VERSION,
} from "../support/v2-semantic-oracle";

const root = process.cwd();
const fixtures = JSON.parse(
  readFileSync(resolve(root, "tests/fixtures/v2/semantic-scenarios.json"), "utf8"),
) as {
  schemaVersion: number;
  contractVersion: string;
  syntheticOnly: boolean;
  fixtures: SemanticFixture[];
};

type Level = "R" | "C" | "—";
type Cell = { level: Level; fixtures?: string[]; verificationId?: string };
type Verification = {
  status: "current" | "future_activation";
  implementingPackage: string;
  testPath: string;
  command: string;
  proves: string;
};
type Matrix = {
  schemaVersion: number;
  contractVersion: string;
  exactBaseCommit: string;
  currentPackage: string;
  currentPackageBaseCommit: string;
  productBehaviorImplementedByP02: boolean;
  implementedProductPackages: string[];
  columns: string[];
  verifications: Record<string, Verification>;
  concerns: Array<{ concernId: string; cells: Record<string, Cell> }>;
  preservedV1Characterization: Array<{
    concern: string;
    testPath: string;
    command: string;
  }>;
};
const matrix = JSON.parse(
  readFileSync(resolve(root, "docs/repbook-v2-verification-matrix.json"), "utf8"),
) as Matrix;

const fixtureIds = Array.from(
  { length: 17 },
  (_, index) => `F${String(index + 1).padStart(2, "0")}`,
);
const columns = [
  "pureContract",
  "databaseService",
  "browser",
  "exportImport",
  "restoreRollback",
  "adversarialPrivacy",
] as const;
const requiredLevels: Record<string, readonly Level[]> = {
  "plan-schedule-preview-start": ["R", "R", "R", "C", "C", "—"],
  "prescribed-versus-performed": ["R", "R", "R", "R", "C", "C"],
  "active-finish-abandon": ["R", "R", "R", "R", "R", "C"],
  "acknowledgement-retry-idempotency": ["R", "R", "R", "—", "C", "C"],
  "planned-order-skip-extra": ["R", "R", "R", "C", "C", "—"],
  "warmup-occurrence-truth": ["R", "R", "R", "C", "C", "—"],
  "superset-current-next-rest": ["R", "R", "R", "C", "C", "—"],
  "immutable-correction-lineage": ["R", "R", "R", "R", "R", "C"],
  "exercise-slot-occurrence-identity": ["R", "R", "C", "R", "R", "C"],
  "measurement-unit-load": ["R", "R", "C", "R", "C", "C"],
  "time-local-date-timezone": ["R", "R", "R", "R", "R", "C"],
  "provenance-evidence-tier": ["R", "R", "C", "R", "R", "C"],
  "missing-unknown-unsupported-na": ["R", "R", "R", "R", "C", "C"],
  "derived-invalidation-recompute": ["R", "R", "R", "C", "R", "C"],
  "recommendation-decision-adaptation": ["R", "R", "R", "R", "R", "R"],
  "exception-only-context": ["R", "R", "R", "C", "C", "C"],
  "future-write-program-editing": ["R", "R", "R", "C", "R", "C"],
  "owner-isolation": ["R", "R", "R", "R", "R", "R"],
  "external-ai-envelope-manifest-import": ["R", "R", "R", "R", "C", "R"],
  "diagnostic-redaction-preview": ["R", "R", "R", "R", "C", "R"],
  "lifecycle-inventory-completeness": ["R", "R", "C", "R", "R", "R"],
};

describe("Repbook v2 ratified semantic contract", () => {
  it("contains exactly the synthetic F01-F17 catalogue", () => {
    expect(fixtures).toMatchObject({
      schemaVersion: 1,
      contractVersion: V2_CONTRACT_VERSION,
      syntheticOnly: true,
    });
    expect(fixtures.fixtures.map((fixture) => fixture.fixtureId)).toEqual(fixtureIds);
    expect(new Set(fixtures.fixtures.map((fixture) => fixture.fixtureId)).size).toBe(17);
    for (const fixture of fixtures.fixtures) {
      expect(fixture.title.length).toBeGreaterThan(0);
      expect(fixture.concerns.length).toBeGreaterThan(0);
      expect(fixture.input.events.length).toBeGreaterThan(0);
      expect(
        fixture.input.syntheticOwnerIds.every((ownerId) => ownerId.startsWith("owner-")),
      ).toBe(true);
      for (const outcome of Object.values(fixture.expected)) {
        expect(outcome.length).toBeGreaterThan(0);
      }
    }
  });

  for (const fixture of fixtures.fixtures) {
    it(`${fixture.fixtureId} ${fixture.title} matches its independent outcome`, () => {
      expect(evaluateSemanticFixture(fixture)).toEqual(
        normalizeSemanticOutcome(fixture.expected),
      );
    });
  }

  it("maps every ratified R/C cell to fixtures and an exact test owner", () => {
    expect(matrix).toMatchObject({
      schemaVersion: 1,
      contractVersion: V2_CONTRACT_VERSION,
      exactBaseCommit: "2c9ab1b9478502f1d08956a6c44dfb0850c8f168",
      currentPackage: "H03",
      currentPackageBaseCommit: "d2cb0674ac3f8bb080e973d3ef392fbec671e6cb",
      productBehaviorImplementedByP02: false,
      implementedProductPackages: [
        "T01",
        "T02",
        "T03",
        "T04",
        "T05",
        "T06",
        "U01",
        "U02",
        "U03",
        "H01",
        "H02",
        "H03",
      ],
    });
    expect(matrix.columns).toEqual(columns);
    expect(matrix.verifications["U01-browser"]).toMatchObject({
      status: "current",
      implementingPackage: "U01",
      testPath: "tests/e2e/v2-u01-active-workout-hierarchy.spec.ts",
      command:
        "npx playwright test --config=playwright.v2-u01.config.ts tests/e2e/v2-u01-active-workout-hierarchy.spec.ts",
    });
    expect(
      existsSync(
        resolve(root, matrix.verifications["U01-browser"].testPath),
      ),
    ).toBe(true);
    expect(matrix.verifications["U02-browser"]).toMatchObject({
      status: "current",
      implementingPackage: "U02",
      testPath: "tests/e2e/v2-u02-exception-context.spec.ts",
      command:
        "npx playwright test --config=playwright.v2-u02.config.ts tests/e2e/v2-u02-exception-context.spec.ts",
    });
    expect(matrix.verifications["U03-browser"]).toMatchObject({
      status: "current",
      implementingPackage: "U03",
      testPath: "tests/e2e/v2-u03-future-program.spec.ts",
      command:
        "npx playwright test --config=playwright.v2-u03.config.ts tests/e2e/v2-u03-future-program.spec.ts",
    });
    expect(matrix.verifications["H01-browser"]).toMatchObject({
      status: "current",
      implementingPackage: "H01",
      testPath: "tests/e2e/v2-h01-performed-first-history.spec.ts",
      command:
        "npx playwright test --config=playwright.v2-h01.config.ts tests/e2e/v2-h01-performed-first-history.spec.ts",
    });
    expect(matrix.concerns.map((concern) => concern.concernId)).toEqual(
      Object.keys(requiredLevels),
    );

    const mappedFixtures = new Set<string>();
    for (const concern of matrix.concerns) {
      expect(columns.map((column) => concern.cells[column]?.level)).toEqual(
        requiredLevels[concern.concernId],
      );
      for (const column of columns) {
        const cell = concern.cells[column];
        expect(cell).toBeDefined();
        if (cell.level === "—") {
          expect(cell).toEqual({ level: "—" });
          continue;
        }
        expect(cell.fixtures?.length).toBeGreaterThan(0);
        for (const fixtureId of cell.fixtures ?? []) {
          expect(fixtureIds).toContain(fixtureId);
          mappedFixtures.add(fixtureId);
        }
        const verification = matrix.verifications[cell.verificationId ?? ""];
        expect(verification).toBeDefined();
        expect(verification.implementingPackage).toMatch(
          /^(?:P02|T0[1-6]|U0[1-3]|H0[235]|A0[145]|D02|R01)$/,
        );
        expect(verification.testPath).toMatch(
          /^tests\/(?:unit|e2e)\/.+\.(?:test|spec)\.ts$/,
        );
        expect(verification.command).toContain(verification.testPath);
        expect(verification.proves).not.toMatch(/\b(?:later|todo|tbd)\b/i);
        if (verification.status === "current") {
          expect(["P02", ...matrix.implementedProductPackages]).toContain(
            verification.implementingPackage,
          );
          expect(existsSync(resolve(root, verification.testPath))).toBe(true);
        } else {
          expect(verification.status).toBe("future_activation");
          expect(["P02", ...matrix.implementedProductPackages]).not.toContain(
            verification.implementingPackage,
          );
        }
      }
    }
    expect([...mappedFixtures].sort()).toEqual(fixtureIds);
  });

  it("names executable, existing v1 characterization tests", () => {
    expect(matrix.preservedV1Characterization.length).toBeGreaterThanOrEqual(7);
    for (const item of matrix.preservedV1Characterization) {
      expect(item.concern.length).toBeGreaterThan(0);
      expect(existsSync(resolve(root, item.testPath))).toBe(true);
      expect(item.command).toBe(`npx vitest run ${item.testPath}`);
    }
  });
});
