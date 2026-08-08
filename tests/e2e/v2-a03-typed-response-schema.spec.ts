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

test("downloads the strict response contract bound to the exact package", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [],
    EXPECTED_FIXTURE_RSC_PATHS,
  );
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto("/export/analysis");
  await page.getByLabel(/Program progress/).check();
  await page.getByLabel("12 weeks").check();
  await page.getByRole("button", { name: "Prepare exact preview" }).click();

  const packageText = await page
    .getByTestId("analysis-package-preview")
    .textContent();
  const instructionsPreview = page.getByTestId(
    "external-analysis-instructions",
  );
  const instructionText = await instructionsPreview.textContent();
  if (!packageText || !instructionText) throw new Error("A03 preview was empty.");
  const packageValue = JSON.parse(packageText) as {
    packageId: string;
    packageNamespace: string;
    evidenceCutoff: string;
    expiresAt: string;
    request: { questionId: string; question: string };
    integrity: { digest: string };
  };

  for (const expected of [
    "repbook-analysis-response",
    "analysis-response/1",
    '"responseId"',
    packageValue.packageId,
    packageValue.packageNamespace,
    packageValue.integrity.digest,
    packageValue.evidenceCutoff,
    packageValue.expiresAt,
    packageValue.request.questionId,
    packageValue.request.question,
    '"type": "review_future_training"',
    '"scope": "future_only_review"',
    "Unknown or extra fields are invalid",
    "Any other effect type is unknown and invalid",
  ]) {
    expect(instructionText).toContain(expected);
  }

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download model instructions" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("A03 instruction download path missing.");
  expect(await readFile(path, "utf8")).toBe(instructionText);

  expect(
    requestedUrls.every((url) => new URL(url).hostname === "127.0.0.1"),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await pageErrors.expectNoUnexpected();
});
