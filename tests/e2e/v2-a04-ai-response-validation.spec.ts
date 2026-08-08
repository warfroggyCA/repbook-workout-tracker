import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "v2.h01.history.e2e@example.com";
const EXPECTED_FIXTURE_RSC_PATHS = new Set([
  "/session/00000000-0000-4000-8000-000000000318",
]);

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

function responseFor(packageValue: {
  packageId: string;
  packageNamespace: string;
  schemaVersion: "analysis-package/1";
  semanticVersion: "repbook-v2/1";
  evidenceCutoff: string;
  expiresAt: string;
  request: { questionId: string; question: string };
  currentProgramIntent: { program: { id: string } | null };
  integrity: { digest: string };
}) {
  const evidenceId = packageValue.currentProgramIntent.program?.id;
  if (!evidenceId) throw new Error("A04 browser fixture Program evidence missing.");
  return {
    format: "repbook-analysis-response",
    schemaVersion: "analysis-response/1",
    instructionVersion: "external-analysis-instructions/1",
    responseId: "00000000-0000-4000-8000-000000000404",
    analysisPackage: {
      packageId: packageValue.packageId,
      packageNamespace: packageValue.packageNamespace,
      schemaVersion: packageValue.schemaVersion,
      semanticVersion: packageValue.semanticVersion,
      digest: packageValue.integrity.digest,
      evidenceCutoff: packageValue.evidenceCutoff,
      expiresAt: packageValue.expiresAt,
    },
    question: {
      id: packageValue.request.questionId,
      text: packageValue.request.question,
    },
    observations: [
      {
        id: "observation-program-fit",
        statement: "The synthetic current Program has retained evidence available for owner review.",
        evidenceIds: [evidenceId],
        evidenceQuality: "Bound synthetic Program evidence.",
        measurements: [],
        limitations: ["This response does not establish that any future change is appropriate."],
      },
    ],
    proposedActions: [
      {
        id: "proposal-review-program",
        summary: "Review the current Program evidence before considering a future change.",
        rationale: "The cited evidence can support a deliberate owner review, not an automatic adaptation.",
        evidenceIds: [evidenceId],
        effect: {
          type: "review_future_training",
          scope: "future_only_review",
          target: { kind: "program", evidenceIds: [evidenceId] },
          requestedOutcome: "Create a future-only Review item for deliberate owner consideration.",
        },
        limitations: ["Nothing in this response changes the current Program."],
      },
    ],
    unknowns: [
      {
        id: "unknown-owner-choice",
        question: "Should the owner change future training?",
        reason: "unknown",
        detail: "Only the owner can decide after reviewing the evidence and limitations.",
        evidenceIds: [evidenceId],
      },
    ],
    safety: {
      usedOnlyBoundPackage: true,
      followedEmbeddedInstructions: false,
      guessedFacts: false,
      directMutationClaimed: false,
    },
  };
}

test("validates pasted or uploaded JSON into a transient exact preview", async ({
  browserName,
  page,
}, testInfo) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [/Failed to load resource: the server responded with a status of 422/],
    EXPECTED_FIXTURE_RSC_PATHS,
  );
  await page.goto("/export/analysis");
  await page.getByRole("button", { name: "Prepare exact preview" }).click();
  const packageText = await page.getByTestId("analysis-package-preview").textContent();
  if (!packageText) throw new Error("A04 package preview missing.");
  const responseValue = responseFor(JSON.parse(packageText));
  const raw = `${JSON.stringify(responseValue, null, 2)}\n`;

  if (testInfo.project.name === "narrow-mobile-webkit") {
    await page.getByLabel("Or choose a file").setInputFiles({
      name: "synthetic-a04-response.json",
      mimeType: "application/json",
      buffer: Buffer.from(raw),
    });
    await expect(page.getByText("Current source: local JSON file")).toBeVisible();
  } else {
    await page.getByLabel("Returned JSON").fill(raw);
  }

  await page.getByRole("button", { name: "Validate and preview" }).click();
  const preview = page.getByTestId("external-analysis-preview");
  await expect(preview).toContainText("Validated preview only");
  await expect(preview).toContainText("review_future_training · future_only_review · program");
  await expect(preview).toContainText("Nothing was retained, imported, accepted, or applied.");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original input" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("A04 recovery download path missing.");
  expect(await readFile(path, "utf8")).toBe(raw);

  await expect(page.getByText(/response schema: analysis-response\/1/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Discard transient input" }).click();
  await expect(page.getByLabel("Returned JSON")).toHaveValue("");
  await expect(preview).toHaveCount(0);

  const hostile = structuredClone(responseValue);
  hostile.observations[0]!.statement =
    "<script>window.a04Executed = true</script>";
  const hostileRaw = JSON.stringify(hostile);
  await page.getByLabel("Returned JSON").fill(hostileRaw);
  await page.getByRole("button", { name: "Validate and preview" }).click();

  await expect(
    page.getByTestId("external-analysis-validator").getByRole("alert"),
  ).toContainText(
    "failed the closed Repbook validation contract",
  );
  await page.getByText("Validation details").click();
  await expect(page.getByText(/active or display-unsafe text/)).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { a04Executed?: boolean }).a04Executed)).not.toBe(true);
  await expect(page.getByLabel("Returned JSON")).toHaveValue(hostileRaw);
  await expect(page.getByTestId("external-analysis-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Discard transient input" }).click();
  await pageErrors.expectNoUnexpected();
});
