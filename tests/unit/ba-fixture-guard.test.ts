import { describe, expect, it } from "vitest";
import { assertBaFixtureEnvironment } from "../helpers/ba-fixture-guard";

const root = "/private/tmp";
const safe = {
  AI_FAKE: "1",
  BA_FIXTURE_MODE: "1",
  DATABASE_URL: "",
  PGLITE_DIR: "/private/tmp/workout-tracker-fresh-ba123",
};

describe("BA fixture environment guard", () => {
  it("accepts only an explicit fresh temporary PGlite target", () => {
    expect(assertBaFixtureEnvironment(safe, root)).toBe(safe.PGLITE_DIR);
  });

  it.each([
    ["missing BA mode", { ...safe, BA_FIXTURE_MODE: "" }],
    ["real AI", { ...safe, AI_FAKE: "" }],
    ["missing PGlite", { ...safe, PGLITE_DIR: "" }],
    ["normal local database", { ...safe, PGLITE_DIR: "/private/tmp/workout-local" }],
    ["path outside temporary root", { ...safe, PGLITE_DIR: "/Volumes/data/workout-tracker-fresh-ba123" }],
    ["normal database URL", { ...safe, DATABASE_URL: "postgresql://localhost/workout" }],
    ["production-looking URL", { ...safe, DATABASE_URL: "postgresql://example.invalid/production" }],
  ])("rejects %s", (_label, environment) => {
    expect(() => assertBaFixtureEnvironment(environment, root)).toThrow();
  });
});
