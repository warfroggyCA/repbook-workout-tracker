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
    const browserGate = steps.find(
      (step) => step.name === "Require every browser suite",
    );

    expect(documentation?.run).toBe("npm run docs:check");
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
      ]),
    );
  });
});
