import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

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
    const programReviewRecovery = steps.find(
      (step) => step.id === "browser-program-review-recovery",
    );
    const browserGate = steps.find(
      (step) => step.name === "Require every browser suite",
    );

    expect(documentation?.run).toBe("npm run docs:check");
    expect(history?.run).toBe("npm run test:e2e:history-calendar");
    expect(programReviewRecovery?.run).toBe(
      "npm run test:e2e:program-editor-review-recovery",
    );
    expect(browserGate?.env?.BROWSER_HISTORY).toBe(
      "${{ steps.browser-history.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"History management:${BROWSER_HISTORY}"',
    );
    expect(browserGate?.env?.BROWSER_PROGRAM_REVIEW_RECOVERY).toBe(
      "${{ steps.browser-program-review-recovery.outcome }}",
    );
    expect(browserGate?.run).toContain(
      '"Program review recovery:${BROWSER_PROGRAM_REVIEW_RECOVERY}"',
    );
  });
});
