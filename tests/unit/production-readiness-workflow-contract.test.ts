import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import playwrightConfig from "../../playwright.config";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as {
  load: (source: string) => unknown;
};

type WorkflowStep = {
  name: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
};

type Workflow = {
  on: {
    push: { branches: string[] };
    pull_request: unknown;
    workflow_dispatch: unknown;
  };
  jobs: Record<
    string,
    {
      needs?: string[];
      steps: WorkflowStep[];
      strategy?: { "fail-fast"?: boolean; matrix?: { group?: string[] } };
    }
  >;
};

type PackageJson = {
  scripts?: Record<string, string>;
};

describe("production readiness workflow contract", () => {
  it("runs branch pushes only for main while retaining the PR gate", async () => {
    const source = await readFile(
      ".github/workflows/production-readiness.yml",
      "utf8",
    );
    const workflow = load(source) as Workflow;

    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("requires core checks and the complete parallel browser matrix", async () => {
    const source = await readFile(
      ".github/workflows/production-readiness.yml",
      "utf8",
    );
    const workflow = load(source) as Workflow;
    const coreSteps = workflow.jobs.core.steps;
    const documentation = coreSteps.find(
      (step) => step.name === "Validate current documentation links",
    );
    const browserRegistry = coreSteps.find(
      (step) => step.name === "Validate protected browser group coverage",
    );
    const isolatedPerformance = coreSteps.find(
      (step) => step.name === "Run isolated production performance budgets",
    );
    const coverage = coreSteps.find(
      (step) =>
        step.name === "Run unit, database, race, failure, and coverage checks",
    );
    const browserSteps = workflow.jobs.browser.steps;
    const browserBuild = browserSteps.find(
      (step) => step.name === "Build production application",
    );
    const browserGroup = browserSteps.find(
      (step) => step.name === "Run protected browser group",
    );
    const collector = workflow.jobs.verify;

    expect(documentation?.run).toBe("npm run docs:check");
    expect(browserRegistry?.run).toBe("npm run ci:browser-groups:check");
    expect(isolatedPerformance?.run).toBe(
      "npm run test:performance:isolated",
    );
    expect(coverage?.run).toBe("npm run test:coverage:ci");
    expect(workflow.jobs.browser.strategy?.["fail-fast"]).toBe(false);
    expect(workflow.jobs.browser.strategy?.matrix?.group).toHaveLength(6);
    expect(browserBuild?.run).toBe("npm run build");
    expect(browserGroup?.run).toBe(
      'node scripts/run-production-browser-group.mjs "${{ matrix.group }}"',
    );
    expect(collector.needs).toEqual([
      "postgres-integration",
      "core",
      "browser",
    ]);
  });

  it("measures the unchanged performance ceiling without parallel test contention", async () => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as PackageJson;

    expect(packageJson.scripts?.["test:performance:isolated"]).toBe(
      "vitest run tests/unit/performance-budgets-db.test.ts --maxWorkers=1 --no-file-parallelism",
    );
    expect(packageJson.scripts?.["test:coverage:ci"]).toBe(
      "vitest run --coverage --exclude tests/unit/performance-budgets-db.test.ts",
    );
    expect(packageJson.scripts?.["test:e2e:v2-t06"]).toBe(
      "playwright test --config=playwright.v2-t06.config.ts --project=desktop-chromium && V2_T06_PORT=3136 playwright test --config=playwright.v2-t06.config.ts --project=narrow-mobile-webkit",
    );
    expect(packageJson.scripts?.["test:e2e:v2-h03"]).toBe(
      "playwright test --config=playwright.v2-h03.config.ts --project=desktop-chromium && V2_H03_PORT=3144 playwright test --config=playwright.v2-h03.config.ts --project=narrow-mobile-webkit",
    );
    expect(packageJson.scripts?.["test:e2e:v2-h04"]).toBe(
      "playwright test --config=playwright.v2-h04.config.ts --project=desktop-chromium && V2_H04_PORT=3146 playwright test --config=playwright.v2-h04.config.ts --project=narrow-mobile-webkit",
    );
    expect(packageJson.scripts?.["test:e2e:v2-h05"]).toBe(
      "playwright test --config=playwright.v2-h05.config.ts --project=desktop-chromium && V2_H05_PORT=3148 playwright test --config=playwright.v2-h05.config.ts --project=narrow-mobile-webkit",
    );
    expect(
      packageJson.scripts?.["test:e2e:active-workout-north-star"],
    ).toBe(
      "env ACTIVE_WORKOUT_PHASE0_CONTRACT_FIXTURE=0 ACTIVE_WORKOUT_NORTH_STAR_PORT=3175 playwright test --config=playwright.active-workout-north-star.config.ts --grep-invert='equipment-decision baseline|Phase 4 equipment-unavailable decision' && env ACTIVE_WORKOUT_PHASE0_CONTRACT_FIXTURE=1 ACTIVE_WORKOUT_NORTH_STAR_PORT=3176 playwright test --config=playwright.active-workout-north-star.config.ts --grep='equipment-decision baseline' && env ACTIVE_WORKOUT_PHASE0_CONTRACT_FIXTURE=0 ACTIVE_WORKOUT_PHASE4_EQUIPMENT_CONFLICT_FIXTURE=1 ACTIVE_WORKOUT_NORTH_STAR_PORT=3177 playwright test --config=playwright.active-workout-north-star.config.ts --grep='Phase 4 equipment-unavailable decision'",
    );
  });

  it("keeps dedicated v2 browser gates out of the stateful smoke journey", () => {
    expect(playwrightConfig.testIgnore).toEqual(
      expect.arrayContaining([
        "v2-t01-recording-truth.spec.ts",
        "v2-t02-acknowledgement-correction.spec.ts",
        "v2-t03-planned-order.spec.ts",
        "v2-t04-warmup-occurrences.spec.ts",
        "v2-t05-execution-semantics.spec.ts",
        "v2-t06-preview-start.spec.ts",
        "v2-u03-future-program.spec.ts",
        "v2-gauntlet-a-recovery.spec.ts",
        "v2-h02-cadence-targets-time.spec.ts",
        "v2-h03-evidence-identity.spec.ts",
        "v2-h04-pain-consistency.spec.ts",
        "v2-h05-evidence-linked-review.spec.ts",
        "v2-d02-support-bundle.spec.ts",
        "v2-r01-lifecycle-audit.spec.ts",
        "active-workout-north-star-phase0.spec.ts",
        "active-workout-north-star-phase5.spec.ts",
      ]),
    );
  });
});
