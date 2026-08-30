import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForHydratedClickHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "v2.h01.history.e2e@example.com";
const EXPECTED_FIXTURE_RSC_PATHS = new Set([
  "/session/00000000-0000-4000-8000-000000000318",
  "/session/00000000-0000-4000-8000-000000000318?reviewTiming=1",
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
  if (!evidenceId) throw new Error("A05 browser fixture Program evidence missing.");
  return {
    format: "repbook-analysis-response",
    schemaVersion: "analysis-response/1",
    instructionVersion: "external-analysis-instructions/1",
    responseId: "00000000-0000-4000-8000-000000000405",
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
    observations: [{
      id: "observation-program-fit",
      statement: "The synthetic current Program has retained evidence available for owner review.",
      evidenceIds: [evidenceId],
      evidenceQuality: "Bound synthetic Program evidence.",
      measurements: [],
      limitations: ["This response does not establish that any future change is appropriate."],
    }],
    proposedActions: [{
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
    }],
    unknowns: [{
      id: "unknown-owner-choice",
      question: "Should the owner change future training?",
      reason: "unknown",
      detail: "Only the owner can decide after reviewing the evidence and limitations.",
      evidenceIds: [evidenceId],
    }],
    safety: {
      usedOnlyBoundPackage: true,
      followedEmbeddedInstructions: false,
      guessedFacts: false,
      directMutationClaimed: false,
    },
  };
}

test("selectively imports external evidence into owner-controlled Review", async ({
  browserName,
  page,
}, testInfo) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [],
    EXPECTED_FIXTURE_RSC_PATHS,
  );
  await page.goto("/export/analysis");
  await page.getByRole("button", { name: "Prepare exact preview" }).click();
  const packageText = await page.getByTestId("analysis-package-preview").textContent();
  if (!packageText) throw new Error("A05 package preview missing.");
  const raw = JSON.stringify(responseFor(JSON.parse(packageText)), null, 2);
  await page.getByLabel("Returned JSON").fill(raw);
  await page.getByRole("button", { name: "Validate and preview" }).click();

  await page.getByLabel("Import this labelled external observation").check();
  await page.getByLabel("Import this proposal into Review").check();
  await page.getByRole("button", { name: "Import selected into Review" }).click();
  const importStatus = page.getByRole("status").filter({
    hasText: "Selected items are in Review",
  });
  await expect(importStatus).toContainText("Selected items are in Review");
  await expect(importStatus).toContainText("The raw response was discarded");
  await expect(page.getByLabel("Returned JSON")).toHaveValue("");

  await page.getByRole("link", { name: "Open Review and decisions" }).click();
  await expect(page).toHaveURL(/\/coach$/);
  const decisionHistoryDisclosure = page.getByText(
    "Decision history and supporting evidence",
    { exact: true },
  );
  const decisionHistoryDetails = decisionHistoryDisclosure.locator(
    "xpath=ancestor::details[1]",
  );
  await openNativeDetails(decisionHistoryDetails);
  await expect(page.getByRole("heading", { name: "Imported external observations" })).toBeVisible();
  await expect(page.getByText("External AI observation")).toBeVisible();
  await expect(page.getByText("External AI proposal · you decide")).toBeVisible();
  const proposal = page
    .locator('section[id^="recommendation-"]')
    .filter({ hasText: "External AI proposal · you decide" });
  await expect(proposal).toContainText("Validated external");
  await expect(proposal).toContainText("does not edit or publish your Program");

  if (testInfo.project.name === "narrow-mobile-webkit") {
    await proposal.getByText("Decide later").click();
    await proposal.getByLabel("Optional revisit date").fill("2026-08-20");
    await proposal.getByLabel("Optional note").fill("Check again after another workout.");
    const defer = proposal.getByRole("button", { name: "Defer review" });
    await waitForHydratedClickHandler(defer);
    await defer.click();
    await expect(page.getByText("Review deferred")).toBeVisible();
  } else {
    const direction = proposal.getByLabel("Direction to accept for future Review");
    await direction.fill("Review a smaller future change after two more workouts.");
    const accept = proposal.getByRole("button", { name: "Accept edited direction" });
    await waitForHydratedClickHandler(accept);
    await accept.click();
    await expect(proposal).toHaveCount(0);
    await openNativeDetails(decisionHistoryDetails);
    await expect(page.getByRole("heading", { name: "Recent decisions" })).toBeVisible();
    await expect(page.getByText("Review a smaller future change after two more workouts.")).toBeVisible();
    await expect(page.getByText("Edited", { exact: true })).toBeVisible();
  }

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await pageErrors.expectNoUnexpected();
});
