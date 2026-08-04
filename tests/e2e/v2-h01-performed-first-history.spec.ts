import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";
import {
  V2_H01_HISTORY_EMAIL,
  V2_H01_HISTORY_IDS as ids,
} from "../helpers/v2-h01-history";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(V2_H01_HISTORY_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/(?:today|settings\/setup)$/);
  await page.waitForLoadState("networkidle");
}

async function expectTouchTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

test("presents performed evidence first without rewriting or inflating History", async ({
  browserName,
  page,
}) => {
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);

  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutationRequests.push(
        `${request.method()} ${new URL(request.url()).pathname}`,
      );
    }
  });

  await page.goto(`/history/${ids.importedSession}`);
  await expect(page).toHaveURL(`/history/${ids.importedSession}`);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Imported performed-first workout",
    }),
  ).toBeVisible();
  await expect(page.getByText("Completed workout", { exact: true })).toBeVisible();
  await expect(page.getByText("Imported evidence", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("Restored from recovery snapshot", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/3 performed working sets/)).toBeVisible();
  await expect(page.getByText(/1 completed warm-up/)).toBeVisible();

  const presentationOrder = await page.locator("main > *").evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (element.id === "performed-exercises") return ["performed"];
      if (
        element.querySelector(":scope > h2")?.textContent?.trim() ===
        "Plan and results"
      ) {
        return ["plan"];
      }
      if (
        element.querySelector(":scope > summary")?.textContent?.trim() ===
        "Retained source records (1)"
      ) {
        return ["retained"];
      }
      return [];
    }),
  );
  expect(presentationOrder).toEqual(["performed", "plan", "retained"]);

  const performed = page.getByRole("region", { name: "What you did" });
  await expect(performed.getByText("Completed warm-ups", { exact: true })).toBeVisible();
  await expect(
    performed.getByRole("heading", {
      level: 3,
      name: "H01 Bodyweight Bulgarian Split Squat",
    }),
  ).toBeVisible();
  await expect(performed.getByText("Supported performed meaning", { exact: true })).toHaveCount(2);
  await expect(performed.getByText("Legacy partial meaning", { exact: true })).toBeVisible();
  await expect(
    performed.getByText(
      "Not used in completed calculations because this legacy set's performed meaning is incomplete.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(performed.getByText("Legacy acknowledged working set", { exact: true })).toBeVisible();
  await expect(performed.getByText("Extra imported working set", { exact: true })).toBeVisible();
  await expect(performed.getByText(/Original Program guidance/)).toHaveCount(0);
  await expect(performed.getByText("Retained unlinked import row", { exact: true })).toHaveCount(0);
  const plan = page
    .getByText("Plan and results", { exact: true })
    .locator("..");
  await expect(plan.getByText("Original exercise guidance", { exact: true })).toBeVisible();
  await expect(plan.getByText(/Original Program guidance/)).toBeVisible();

  const correctionEvidence = performed.locator("details", {
    hasText: "Correction and restore evidence",
  });
  await correctionEvidence.locator("summary").focus();
  await expect(correctionEvidence.locator("summary")).toBeFocused();
  await correctionEvidence.locator("summary").press("Enter");
  await expect(correctionEvidence).toHaveAttribute("open", "");
  await expect(correctionEvidence).toContainText("Corrected from History");
  await expect(correctionEvidence).toContainText("Repetitions: 10 → 12");
  await expect(correctionEvidence).toContainText("Recovery snapshot restored");
  await expect(correctionEvidence).toContainText("Repetitions: 12 → 11");
  await expect(correctionEvidence).toContainText(ids.snapshot);

  const plannedLink = performed.getByRole("link", { name: "Original plan" });
  await expect(plannedLink).toHaveAttribute(
    "href",
    `#occurrence-${ids.importedWarmupOccurrence}`,
  );
  const performedLink = plan
    .getByRole("link", { name: "Performed evidence" })
    .first();
  await expect(performedLink).toHaveAttribute(
    "href",
    `#performed-set-${ids.importedSet}`,
  );

  const retained = page.locator("details", {
    hasText: "Retained source records (1)",
  });
  await expect(retained).not.toHaveAttribute("open", "");
  await retained.locator("summary").focus();
  await retained.locator("summary").press("Enter");
  await expect(retained).toHaveAttribute("open", "");
  await expect(retained).toContainText("Retained unlinked import row");
  await expect(retained).toContainText("not counted as performed working sets");

  const source = page.locator("details", { hasText: "Source and lineage details" });
  await source.locator("summary").click();
  await expect(
    source.getByText("History revision", { exact: true }).locator(".."),
  ).toContainText("2");
  await expect(source).toContainText(ids.importBatch);
  await expect(source).toContainText("hevy-workout-h01");

  if ((page.viewportSize()?.width ?? 0) <= 320) {
    await page.evaluate(() => {
      document.documentElement.dataset.fontSize = "extra-large";
    });
    await expectNoHorizontalOverflow(page);
    await expectTouchTarget(correctionEvidence.locator("summary"));
    await expectTouchTarget(retained.locator("summary"));
    await expectTouchTarget(source.locator("summary"));
    await expectTouchTarget(plannedLink);
    await expectTouchTarget(performedLink);
  }

  await page.goto(`/history/${ids.finishedEarlySession}`);
  await expect(page.getByText("Finished early", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Recorded in Repbook", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Corrected evidence", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Timing corrected 1 time/)).toBeVisible();
  await expect(page.getByText(/1 performed working set/)).toBeVisible();
  await expect(page.getByText(/Items left when you finished stay in the original plan/)).toBeVisible();

  await page.goto(`/history/${ids.abandonedSession}`);
  await expect(page.getByText("Abandoned workout", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/1 performed working set/)).toBeVisible();
  await expect(
    page.getByText(
      "Excluded from completed metrics, progression, and Review because the workout was abandoned.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Acknowledged before abandonment", { exact: true })).toBeVisible();

  await page.goto(`/history/${ids.activeSession}`);
  await expect(page).toHaveURL(`/session/${ids.activeSession}`);
  expect(mutationRequests).toEqual([]);
  await pageErrors.expectNoUnexpected();
});
