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
  jobs: Record<string, { steps: WorkflowStep[] }>;
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

  it("requires documentation and the complete History browser matrix", async () => {
    const source = await readFile(
      ".github/workflows/production-readiness.yml",
      "utf8",
    );
    const workflow = load(source) as Workflow;
    const steps = workflow.jobs.verify.steps;
    const documentation = steps.find(
      (step) => step.name === "Validate current documentation links",
    );
    const isolatedPerformance = steps.find(
      (step) => step.name === "Run isolated production performance budgets",
    );
    const coverage = steps.find(
      (step) =>
        step.name === "Run unit, database, race, failure, and coverage checks",
    );
    const history = steps.find((step) => step.id === "browser-history");
    const painHold = steps.find((step) => step.id === "browser-pain-hold");
    const programReviewRecovery = steps.find(
      (step) => step.id === "browser-program-review-recovery",
    );
    const t02AcknowledgementCorrection = steps.find(
      (step) => step.id === "browser-v2-t02",
    );
    const t03PlannedOrder = steps.find(
      (step) => step.id === "browser-v2-t03",
    );
    const t04WarmupOccurrences = steps.find(
      (step) => step.id === "browser-v2-t04",
    );
    const t05ExecutionSemantics = steps.find(
      (step) => step.id === "browser-v2-t05",
    );
    const t06PreviewStart = steps.find(
      (step) => step.id === "browser-v2-t06",
    );
    const u03FutureProgram = steps.find(
      (step) => step.id === "browser-v2-u03",
    );
    const gauntletA = steps.find(
      (step) => step.id === "browser-v2-gauntlet-a",
    );
    const browserGate = steps.find(
      (step) => step.name === "Require every browser suite",
    );

    expect(documentation?.run).toBe("npm run docs:check");
    expect(isolatedPerformance?.run).toBe(
      "npm run test:performance:isolated",
    );
    expect(coverage?.run).toBe("npm run test:coverage:ci");
    expect(history?.run).toBe("npm run test:e2e:history-calendar");
    expect(painHold?.run).toBe("npm run test:e2e:pain-hold");
    expect(programReviewRecovery?.run).toBe(
      "npm run test:e2e:program-editor-review-recovery",
    );
    expect(t02AcknowledgementCorrection?.run).toBe(
      "npm run test:e2e:v2-t02",
    );
    expect(t03PlannedOrder?.run).toBe("npm run test:e2e:v2-t03");
    expect(t04WarmupOccurrences?.run).toBe("npm run test:e2e:v2-t04");
    expect(t05ExecutionSemantics?.run).toBe("npm run test:e2e:v2-t05");
    expect(t06PreviewStart?.run).toBe("npm run test:e2e:v2-t06");
    expect(u03FutureProgram?.run).toBe("npm run test:e2e:v2-u03");
    expect(gauntletA?.run).toBe("npm run test:e2e:v2-gauntlet-a");
    expect(browserGate?.env?.BROWSER_HISTORY).toBe(
      "${{ steps.browser-history.outcome }}",
    );
    expect(browserGate?.env?.BROWSER_PAIN_HOLD).toBe(
      "${{ steps.browser-pain-hold.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"History management:${BROWSER_HISTORY}"',
    );
    expect(browserGate?.run).toContain(
      '"pain-hold notice:${BROWSER_PAIN_HOLD}"',
    );
    expect(browserGate?.env?.BROWSER_PROGRAM_REVIEW_RECOVERY).toBe(
      "${{ steps.browser-program-review-recovery.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"Program review recovery:${BROWSER_PROGRAM_REVIEW_RECOVERY}"',
    );
    expect(browserGate?.env?.BROWSER_V2_T02).toBe(
      "${{ steps.browser-v2-t02.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"T02 acknowledgement and correction:${BROWSER_V2_T02}"',
    );
    expect(browserGate?.env?.BROWSER_V2_T03).toBe(
      "${{ steps.browser-v2-t03.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"T03 planned order and extra-set truth:${BROWSER_V2_T03}"',
    );
    expect(browserGate?.env?.BROWSER_V2_T04).toBe(
      "${{ steps.browser-v2-t04.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"T04 warm-up occurrence truth:${BROWSER_V2_T04}"',
    );
    expect(browserGate?.env?.BROWSER_V2_T05).toBe(
      "${{ steps.browser-v2-t05.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"T05 current, next, group, and rest truth:${BROWSER_V2_T05}"',
    );
    expect(browserGate?.env?.BROWSER_V2_T06).toBe(
      "${{ steps.browser-v2-t06.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"T06 preview and Start truth:${BROWSER_V2_T06}"',
    );
    expect(browserGate?.env?.BROWSER_V2_U01).toBe(
      "${{ steps.browser-v2-u01.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"U01 active-workout hierarchy:${BROWSER_V2_U01}"',
    );
    expect(browserGate?.env?.BROWSER_V2_U02).toBe(
      "${{ steps.browser-v2-u02.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"U02 exception-only context:${BROWSER_V2_U02}"',
    );
    expect(browserGate?.env?.BROWSER_V2_U03).toBe(
      "${{ steps.browser-v2-u03.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"U03 future-only Program publication:${BROWSER_V2_U03}"',
    );
    expect(browserGate?.env?.BROWSER_V2_GAUNTLET_A).toBe(
      "${{ steps.browser-v2-gauntlet-a.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"Repbook v2 Gauntlet A:${BROWSER_V2_GAUNTLET_A}"',
    );
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
      ]),
    );
  });
});
