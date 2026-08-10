import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "owner@example.com";

async function waitForReactHandler(locator: Locator) {
  await expect
    .poll(
      async () => {
        if ((await locator.count()) !== 1) return false;
        return locator.evaluate((element) => {
          const propsKey = Object.getOwnPropertyNames(element).find((name) =>
            name.startsWith("__reactProps$"),
          );
          if (!propsKey) return false;
          const props = (element as unknown as Record<string, unknown>)[propsKey];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as { onClick?: unknown }).onClick === "function"
          );
        });
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

test("previews, minimizes, and deliberately downloads a separate local support bundle", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const narrow = (page.viewportSize()?.width ?? 0) <= 320;
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto("/export");
  const supportLink = page.locator('a[href="/export/support"]');
  await expect(supportLink).toHaveAccessibleName("Prepare support bundle");
  await expect(page.locator('a[href="/export/analysis"]')).toHaveAccessibleName(
    "Prepare analysis package",
  );
  await supportLink.click();
  await expect(
    page.getByRole("heading", { name: "Support bundle" }),
  ).toBeVisible();
  await expect(page.getByText("Repbook never sends the bundle for you.")).toBeVisible();

  await page.getByLabel(/A page looked or behaved incorrectly/).check();
  await page.getByLabel(/Content was clipped or extended off screen/).check();
  requestedUrls.length = 0;

  const prepare = page.getByRole("button", {
    name: "Prepare exact local preview",
  });
  await waitForReactHandler(prepare);
  await prepare.focus();
  await expect(prepare).toBeFocused();
  await prepare.press("Enter");

  const preview = page.getByTestId("support-bundle-preview");
  await expect(preview).toBeVisible();
  const firstText = await preview.textContent();
  if (firstText == null) throw new Error("Exact support preview was empty.");
  const firstBundle = JSON.parse(firstText) as {
    schemaVersion: string;
    redactionVersion: string;
    purpose: string;
    correlationId: string;
    application: { version: string };
    problem: { type: string; errorCode: string };
    diagnosticContext: {
      collectionStatus: string;
      observations: Record<string, unknown>;
    };
    privacy: {
      localExportOnly: boolean;
      automaticUpload: boolean;
      stableIdentityIncluded: boolean;
      automaticTrainingFactCollection: boolean;
      serverDiagnosticLogLinesIncluded: boolean;
      aiAnalysisContentIncluded: boolean;
    };
  };
  expect(firstBundle).toEqual(
    expect.objectContaining({
      schemaVersion: "support-bundle/1",
      redactionVersion: "support-redaction/1",
      purpose: "repbook_support_diagnosis",
      application: expect.objectContaining({ version: "2.0.0" }),
      problem: { type: "page_display", errorCode: "layout_overflow" },
      privacy: {
        localExportOnly: true,
        automaticUpload: false,
        stableIdentityIncluded: false,
        automaticTrainingFactCollection: false,
        serverDiagnosticLogLinesIncluded: false,
        aiAnalysisContentIncluded: false,
      },
    }),
  );
  expect(firstBundle.correlationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(firstBundle.diagnosticContext.collectionStatus).toBe("populated");
  expect(Object.keys(firstBundle.diagnosticContext.observations).sort()).toEqual([
    "browserFamily",
    "viewportClass",
  ]);
  expect(firstText).not.toContain(EMAIL);
  expect(firstText).not.toMatch(
    /Barbell|workoutId|actualWeight|repetitions|providerBody|analysis-package/i,
  );
  expect(requestedUrls).toEqual([]);

  await page.getByLabel("Include coarse browser context").uncheck();
  await expect
    .poll(async () =>
      Object.hasOwn(JSON.parse((await preview.textContent()) ?? "{}"), "diagnosticContext"),
    )
    .toBe(false);

  await page.getByLabel("Include my optional note").check();
  await page
    .getByLabel(/Optional owner-written note/)
    .fill("Synthetic owner-selected support context.");
  await expect(preview).toContainText("Synthetic owner-selected support context.");
  await expect(preview).toContainText(
    '"mayContainPrivateTrainingOrHealthDetails": true',
  );

  await page.getByLabel("Include my optional note").uncheck();
  await expect(preview).not.toContainText("Synthetic owner-selected support context.");
  const finalText = await preview.textContent();
  if (finalText == null) throw new Error("Final support preview was empty.");
  const finalBundle = JSON.parse(finalText) as Record<string, unknown>;
  expect(finalBundle).not.toHaveProperty("diagnosticContext");
  expect(finalBundle).not.toHaveProperty("ownerProvided");

  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download exact support bundle" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^repbook-support-page_display-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Support bundle download path missing.");
  expect(await readFile(downloadPath, "utf8")).toBe(finalText);
  expect(requestedUrls).toEqual([]);

  if (narrow) {
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  expect(
    requestedUrls.every((url) => new URL(url).hostname === "127.0.0.1"),
  ).toBe(true);
  await pageErrors.expectNoUnexpected();
});
