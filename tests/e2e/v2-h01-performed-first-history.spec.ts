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
  // This History-only fixture deliberately has no active Program. Its
  // authenticated landing path is therefore /today -> /setup -> the completed
  // account's setup-management page. Wait for that terminal redirect before
  // starting an independent History navigation.
  await expect(page).toHaveURL(/\/settings\/setup$/);
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
  page: authPage,
}) => {
  await signIn(authPage);

  // Authentication lands this deliberately Program-less fixture on the setup
  // management page. Run the History proof in a fresh page within the same
  // authenticated context so delayed WebKit cancellations from that unrelated
  // setup page cannot be misattributed to History.
  const page = await authPage.context().newPage();
  await installNextDevelopmentRefreshControl(page);
  await authPage.close();
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
  await expect(page.getByText(/Imported evidence/).first()).toBeVisible();
  await expect(
    page.getByText(/Restored from recovery snapshot/).first(),
  ).toBeVisible();
  await expect(page.getByText(/3 working sets/)).toBeVisible();
  await expect(page.getByText(/1 completed warm-up/)).toBeVisible();
  const summary = page.getByRole("region", { name: "Workout summary" });
  for (const question of [
    "What happened?",
    "What changed?",
    "Was anything notable?",
    "Does anything deserve action next time?",
  ]) {
    await expect(summary.getByText(question, { exact: true })).toBeVisible();
  }

  const presentationOrder = await page.locator("main > *").evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (element.getAttribute("data-testid") === "workout-summary") {
        return ["summary"];
      }
      if (element.id === "performed-exercises") return ["performed"];
      if (
        element.querySelector(":scope > h2")?.textContent?.trim() ===
        "Plan and results"
      ) {
        return ["plan"];
      }
      if (element.id === "technical-record") return ["technical"];
      return [];
    }),
  );
  expect(presentationOrder).toEqual([
    "summary",
    "performed",
    "plan",
    "technical",
  ]);

  const performed = page.getByRole("region", { name: "What you did" });
  await expect(performed.getByText("Completed warm-ups", { exact: true })).toBeVisible();
  await expect(
    performed.getByRole("heading", {
      level: 3,
      name: "H01 Bodyweight Bulgarian Split Squat",
    }),
  ).toBeVisible();
  await expect(performed.getByRole("button", { name: "Correct set" })).toHaveCount(3);
  await expect(
    performed.getByText("Supported performed meaning", { exact: true }).first(),
  ).toBeHidden();
  await expect(
    performed.getByText("Legacy partial meaning", { exact: true }),
  ).toBeHidden();
  await expect(
    performed.getByText("Set details · calculations unavailable", { exact: true }),
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
  await expect(correctionEvidence).not.toHaveAttribute("open", "");
  await correctionEvidence.locator("summary").focus();
  await expect(correctionEvidence.locator("summary")).toBeFocused();
  await correctionEvidence.locator("summary").press("Enter");
  await expect(correctionEvidence).toHaveAttribute("open", "");
  await expect(
    correctionEvidence.getByText("Supported performed meaning", { exact: true }),
  ).toBeVisible();
  await expect(correctionEvidence).toContainText("Corrected from History");
  await expect(correctionEvidence).toContainText("Repetitions: 10 → 12");
  await expect(correctionEvidence).toContainText("Recovery snapshot restored");
  await expect(correctionEvidence).toContainText("Repetitions: 12 → 11");
  await expect(correctionEvidence).toContainText(ids.snapshot);

  const legacySetDetails = page.locator(
    `#performed-set-${ids.importedLegacySet} details`,
  );
  await legacySetDetails.locator("summary").click();
  await expect(
    legacySetDetails.getByText("Legacy partial meaning", { exact: true }),
  ).toBeVisible();
  await expect(
    legacySetDetails.getByText(
      "Not used in completed calculations because this legacy set's performed meaning is incomplete.",
      { exact: true },
    ),
  ).toBeVisible();

  const plannedLink = performed.getByRole("link", { name: "Original plan" });
  await expect(plannedLink).toHaveAttribute(
    "href",
    `#occurrence-${ids.importedWarmupOccurrence}`,
  );
  const technical = page.locator("#technical-record");
  await expect(technical).not.toHaveAttribute("open", "");
  const performedLink = technical
    .locator(`a[href="#performed-set-${ids.importedSet}"]`)
    .first();
  await expect(performedLink).toHaveAttribute(
    "href",
    `#performed-set-${ids.importedSet}`,
  );
  await plannedLink.click();
  await expect(technical).toHaveAttribute("open", "");
  await expect(page.locator(`#occurrence-${ids.importedWarmupOccurrence}`)).toBeVisible();

  const retained = technical.locator("details", {
    hasText: "Retained source records (1)",
  });
  await expect(retained).not.toHaveAttribute("open", "");
  await retained.locator("summary").focus();
  await retained.locator("summary").press("Enter");
  await expect(retained).toHaveAttribute("open", "");
  await expect(retained).toContainText("Retained unlinked import row");
  await expect(retained).toContainText("not counted as performed working sets");

  const source = technical
    .getByRole("heading", { name: "Source and lineage", exact: true })
    .locator("..");
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
    await expectTouchTarget(technical.locator(":scope > summary"));
    await expectTouchTarget(retained.locator("summary"));
    await expectTouchTarget(plannedLink);
    await expectTouchTarget(performedLink);
  }

  await page.goto(`/history/${ids.finishedEarlySession}`);
  await expect(
    page.getByText("Completed; legacy incomplete outcome", { exact: true }).first(),
  ).toBeVisible();
  const finishedSetDetails = page.locator(`#performed-set-${ids.finishedSet} details`);
  await expect(finishedSetDetails).not.toHaveAttribute("open", "");
  await finishedSetDetails.locator("summary").click();
  await expect(page.getByText("Recorded in Repbook", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Corrected evidence/).first()).toBeVisible();
  await page.locator("#technical-record > summary").click();
  await expect(page.getByText(/Timing corrected 1 time/)).toBeVisible();
  await expect(page.getByText(/1 working set/)).toBeVisible();
  await expect(page.getByText(/Older occurrence text indicates work remained/)).toBeVisible();

  await page.goto(`/history/${ids.abandonedSession}`);
  await expect(page.getByText("Abandoned workout", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/1 working set/)).toBeVisible();
  const abandonedSetDetails = page.locator(`#performed-set-${ids.abandonedSet} details`);
  await expect(abandonedSetDetails.locator("summary")).toHaveText(
    "Set details · calculations unavailable",
  );
  await abandonedSetDetails.locator("summary").click();
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

test("clears an exact retained set copy after its workout has ended", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings");
  await page.evaluate((fixtureIds) => {
    localStorage.setItem(
      "workout-tracker:workout-set-outbox:v1",
      JSON.stringify({
        version: 4,
        entries: [
          {
            clientKey: fixtureIds.finishedSetClientKey,
            ownerId: fixtureIds.user,
            sessionId: fixtureIds.finishedEarlySession,
            sessionExerciseId: fixtureIds.finishedSessionExercise,
            occurrenceId: fixtureIds.finishedOccurrence,
            expectedOccurrenceRevision: 0,
            performedExerciseId: fixtureIds.performedExercise,
            performedSemanticsVersion: 1,
            performedLoadType: "bodyweight",
            performedLoadSemantics: "bodyweight",
            workoutName: "Finished early workout",
            exerciseName: "H01 Bodyweight Bulgarian Split Squat",
            setNo: 1,
            metricType: "reps",
            weight: null,
            weightUnit: null,
            reps: 8,
            distanceKm: null,
            durationSeconds: null,
            rpe: null,
            rir: null,
            techniqueIssue: null,
            limitationCause: null,
            pain: null,
            note: null,
            equipmentSnapshotId: null,
            loadEntryMeaning: "legacy_unknown",
            observedCompletedAtISO: null,
            createdAtISO: new Date().toISOString(),
            status: "queued",
            attemptCount: 1,
            nextAttemptAtISO: null,
            lastAttemptAtISO: new Date().toISOString(),
            lastError: "This workout has ended. Check this set before removing it.",
          },
        ],
      }),
    );
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  }, ids);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:workout-set-outbox:v1",
        );
        if (!raw) return 0;
        return (JSON.parse(raw) as { entries: unknown[] }).entries.length;
      }),
    )
    .toBe(0);
  await expect(
    page.getByRole("button", { name: "Open sets waiting to save" }),
  ).toHaveCount(0);

  await page.goto(`/history/${ids.finishedEarlySession}`);
  await expect(page.locator(`#performed-set-${ids.finishedSet}`)).toContainText(
    "8 reps",
  );
  await expect(page.getByText(/1 working set/)).toBeVisible();
});
