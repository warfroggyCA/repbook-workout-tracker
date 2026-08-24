import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { canonicalJson } from "@/services/snapshot-crypto";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "v2.h01.history.e2e@example.com";
const EXPECTED_FIXTURE_RSC_PATHS = new Set([
  "/session/00000000-0000-4000-8000-000000000318",
]);

async function waitForReactHandler(locator: Locator) {
  await expect.poll(async () => {
    if ((await locator.count()) !== 1) return false;
    return locator.evaluate((element) => {
      const propsKey = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith("__reactProps$"),
      );
      if (!propsKey) return false;
      const props = (element as unknown as Record<string, unknown>)[propsKey];
      return typeof props === "object" && props !== null &&
        typeof (props as { onClick?: unknown }).onClick === "function";
    });
  }, { timeout: 30_000 }).toBe(true);
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

test("previews and downloads one complete owner-controlled package without transmission", async ({
  browserName,
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { __repbookClipboard?: string })
            .__repbookClipboard = value;
        },
      },
    });
  });
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(
    page,
    browserName,
    [],
    EXPECTED_FIXTURE_RSC_PATHS,
  );
  const narrow = (page.viewportSize()?.width ?? 0) <= 320;
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto("/export");
  await openNativeDetails(page.locator("details").filter({
    has: page.getByText("Advanced exports", { exact: true }),
  }));
  const packageLink = page.locator('a[href="/export/analysis"]');
  await expect(packageLink).toHaveAccessibleName("Prepare analysis package");
  await packageLink.click();
  await expect(page.getByRole("heading", { name: "Analysis package" })).toBeVisible();
  if (narrow) {
    await expect.poll(() =>
      page.evaluate(() => document.documentElement.dataset.fontSize)
    ).toBe("extra-large");
  }

  await page.getByLabel(/Recovery and constraints/).check();
  await page.getByLabel("12 weeks").check();
  const prepare = page.getByRole("button", { name: "Prepare exact preview" });
  await prepare.focus();
  await expect(prepare).toBeFocused();
  await prepare.press("Enter");

  const preview = page.getByTestId("analysis-package-preview");
  await expect(preview).toBeVisible();
  const exactText = await preview.textContent();
  if (exactText == null) throw new Error("Exact analysis preview was empty.");
  const packageValue = JSON.parse(exactText) as Record<string, unknown> & {
    packageId: string;
    schemaVersion: string;
    semanticVersion: string;
    request: { questionId: string; windowDays: number };
    integrity: { digest: string };
    inventory: { included: Record<string, number>; omitted: Array<{ category: string }> };
    exerciseIdentities: Array<{ values: { identity_scope: string } }>;
    completedOrImportedEvidence: {
      sets: Array<{ factClass: string; evidenceQuality: string }>;
      coachVisibleNotes: Array<{ values: { body: string } }>;
    };
    independentActivityContext: Array<{ evidenceQuality: string }>;
    calculatedMetrics: Array<{ factClass: string; evidenceQuality: string }>;
  };
  expect(packageValue.schemaVersion).toBe("analysis-package/1");
  expect(packageValue.semanticVersion).toBe("repbook-v2/1");
  expect(packageValue.request).toEqual(expect.objectContaining({
    questionId: "recovery_constraints",
    windowDays: 84,
  }));
  expect(packageValue.inventory.included.completedSets).toBeGreaterThan(0);
  expect(packageValue.inventory.included.painLogs).toBe(1);
  expect(packageValue.inventory.included.fatigueLogs).toBe(1);
  expect(packageValue.inventory.omitted.map((item) => item.category)).toEqual(
    expect.arrayContaining([
      "account_identity",
      "raw_ai_and_provider_material",
      "private_contextual_notes",
      "raw_package_retention",
    ]),
  );
  expect(packageValue.exerciseIdentities.map((item) => item.values.identity_scope)).toEqual(
    expect.arrayContaining(["shared", "owner_created"]),
  );
  expect(packageValue.completedOrImportedEvidence.sets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ factClass: "imported" }),
      expect.objectContaining({ evidenceQuality: "performed_semantics_unknown" }),
    ]),
  );
  expect(packageValue.completedOrImportedEvidence.coachVisibleNotes[0]?.values.body)
    .toBe("Synthetic coach-visible analysis context");
  expect(packageValue.independentActivityContext[0]?.evidenceQuality)
    .toBe("context_only_excluded_from_strength");
  expect(packageValue.calculatedMetrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ factClass: "unknown" }),
    ]),
  );
  expect(exactText).not.toContain(EMAIL);
  expect(exactText).not.toContain("synthetic H01 browser fixture");
  expect(exactText).not.toContain("SYNTHETIC PRIVATE NOTE MUST NOT LEAVE REPBOOK");

  await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "JSON copied", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __repbookClipboard?: string }).__repbookClipboard,
    ),
  ).toBe(exactText);

  const { integrity, ...core } = packageValue;
  const digest = createHash("sha256")
    .update(canonicalJson(core))
    .digest("hex");
  expect(digest).toBe(integrity.digest);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download exact JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^repbook-analysis-recovery_constraints-\d{4}-\d{2}-\d{2}\.json$/,
  );
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Analysis package download path missing.");
  expect(await readFile(downloadPath, "utf8")).toBe(exactText);

  const activeManifest = page.getByText(/analysis-package\/1 · [0-9a-f]{64} · active/);
  await expect(activeManifest).toBeVisible();
  const deleteButton = page.getByRole("button", { name: /Delete manifest/ });
  await waitForReactHandler(deleteButton);
  await deleteButton.click();
  await expect(page.getByTestId("analysis-package-preview")).toHaveCount(0);
  await expect(page.getByText("No package manifests retained.")).toBeVisible();

  expect(
    requestedUrls.every((url) => new URL(url).hostname === "127.0.0.1"),
  ).toBe(true);
  if (narrow) {
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBeLessThanOrEqual(1);
    const fontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(fontSize).toBeCloseTo(23.2, 4);
  }
  await pageErrors.expectNoUnexpected();
});
