import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";
import {
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function signInAndStart(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(extraLarge);
  await extraLarge.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");

  await page.goto("/today");
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await page.locator("summary").filter({ hasText: "Workout options" }).click();
  const includeWarmups = page.getByRole("checkbox", {
    name: /Include programmed warm-ups/,
  });
  await expect(includeWarmups).not.toBeChecked();
  await includeWarmups.check();
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

function warmupRow(panel: Locator, label: string) {
  return panel.locator("li").filter({ hasText: label });
}

async function waitForSaved(row: Locator) {
  await expect(row.getByText("Saved", { exact: true })).toBeVisible();
}

test("keeps warm-up actions singular, reversible, durable, and usable with minimal attention", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStart(page);
  const sessionId = page.url().split("/").at(-1)!;
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  const panel = page.getByRole("region", { name: "Warm-up", exact: true });
  const actions = panel.locator("li");

  await expect(panel).toContainText("Complete the current warm-up action below.");
  await expect(panel).toContainText(
    `0 done · ${PRODUCTION_WORKOUT_START_WARMUP.length} left`,
  );
  const remainingPreparations = page.getByTestId(
    "remaining-exercise-preparations",
  );
  await expect(remainingPreparations).toContainText("Opening warm-up:");
  await expect(remainingPreparations).not.toContainText("Later, before");
  await expect(remainingPreparations).toContainText("preparation set");
  await expect(actions).toHaveCount(PRODUCTION_WORKOUT_START_WARMUP.length);
  await expect(warmupRow(panel, PRODUCTION_WORKOUT_START_WARMUP[0].label))
    .toBeVisible();
  await expect(warmupRow(panel, PRODUCTION_WORKOUT_START_WARMUP[1].label))
    .not.toBeVisible();
  await panel.getByRole("button", { name: "Review full plan", exact: true })
    .click();
  for (const action of PRODUCTION_WORKOUT_START_WARMUP) {
    const row = warmupRow(panel, action.label);
    await expect(row).toHaveCount(1);
    await expect(
      row.getByRole("checkbox", {
        name: `Mark ${action.label} complete`,
        exact: true,
      }),
    ).toHaveCount(1);
  }

  const firstWarmupLabel = PRODUCTION_WORKOUT_START_WARMUP[0].label;
  const firstWarmupCheckbox = warmupRow(panel, firstWarmupLabel).getByRole(
    "checkbox",
    { name: `Mark ${firstWarmupLabel} complete`, exact: true },
  );
  const firstWarmupId = await warmupRow(panel, firstWarmupLabel)
    .getAttribute("id");
  expect(firstWarmupId).toMatch(/^warmup-occurrence-/);
  const preparationCta = page
    .getByTestId("session-preparation-panel")
    .getByRole("link", { name: "Go to warm-up", exact: true });
  await expect(preparationCta).toHaveAttribute("href", `#${firstWarmupId}`);
  await preparationCta.focus();
  await page.keyboard.press("Enter");
  await expect(firstWarmupCheckbox).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#${firstWarmupId}$`));
  await expect.poll(() => firstWarmupCheckbox.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const dockTop = dock?.getBoundingClientRect().top ?? window.innerHeight;
    return bounds.top >= 0 && bounds.bottom <= dockTop - 8;
  })).toBe(true);
  const focusClearance = await firstWarmupCheckbox.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });
  expect(focusClearance.height).toBeGreaterThanOrEqual(44);
  expect(focusClearance.overflow).toBeLessThanOrEqual(1);
  if (originalViewport) await page.setViewportSize(originalViewport);

  const dayOverview = BA_WORKOUT_FIXTURE.program.days[0].warmupNotes;
  await expect(page.getByText(dayOverview, { exact: true })).toHaveCount(1);
  await expect(page.getByText(dayOverview, { exact: true })).not.toBeVisible();
  await expect(
    page.getByText("Build gradually before the first work set.", { exact: true }),
  ).toHaveCount(1);

  const completedLabel = PRODUCTION_WORKOUT_START_WARMUP[0].label;
  let completedRow = warmupRow(panel, completedLabel);
  await completedRow.getByRole("button", { name: "Add note", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workout-item note").fill("Setup felt stable");
  await dialog.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await waitForSaved(completedRow);
  const complete = completedRow.getByRole("checkbox", {
    name: `Mark ${completedLabel} complete`,
    exact: true,
  });
  await panel.getByRole("button", { name: "Hide full plan", exact: true })
    .click();
  await complete.press("Enter");
  const completedDisclosure = panel.getByRole("button", {
    name: /Completed warm-ups · 1/,
  });
  await expect(completedDisclosure).toBeVisible();
  await expect(completedDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(completedRow).not.toBeVisible();
  await completedDisclosure.click();
  await expect(completedDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(completedRow.getByRole("button", { name: "Undo completion" }))
    .toBeVisible();
  await waitForSaved(completedRow);

  await page.reload({ waitUntil: "networkidle" });
  let reloadedPanel = page.locator("#workout-warmup");
  await reloadedPanel
    .getByRole("button", { name: "Review full plan", exact: true })
    .click();
  completedRow = warmupRow(reloadedPanel, completedLabel);
  await expect(completedRow).toContainText("Note: Setup felt stable");
  await expect(
    completedRow.getByRole("checkbox", {
      name: `${completedLabel} complete`,
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await completedRow.getByRole("button", { name: "Undo completion" }).click();
  await expect(
    completedRow.getByRole("checkbox", {
      name: `Mark ${completedLabel} complete`,
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(completedRow).toContainText("Note: Setup felt stable");
  await waitForSaved(completedRow);

  const quickSkippedLabel = PRODUCTION_WORKOUT_START_WARMUP[1].label;
  let quickSkippedRow = warmupRow(
    page.locator("#workout-warmup"),
    quickSkippedLabel,
  );
  const quickSkip = quickSkippedRow.getByRole("button", {
    name: "Skip due to time",
    exact: true,
  });
  await page.context().setOffline(true);
  await quickSkip.dblclick();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem(
      "workout-tracker:occurrence-mutation-outbox:v1",
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      entries?: Array<{ operation?: string; reasonCode?: string | null }>;
    };
    return (parsed.entries ?? []).map((entry) => ({
      operation: entry.operation,
      reasonCode: entry.reasonCode,
    }));
  })).toEqual([{
    operation: "skip",
    reasonCode: "time_limit_reached",
  }]);
  await page.context().setOffline(false);
  await expect(
    quickSkippedRow.getByRole("button", { name: "Restore" }),
  ).toBeVisible();
  await waitForSaved(quickSkippedRow);

  await page.reload({ waitUntil: "networkidle" });
  reloadedPanel = page.locator("#workout-warmup");
  await reloadedPanel
    .getByRole("button", { name: "Review full plan", exact: true })
    .click();
  quickSkippedRow = warmupRow(reloadedPanel, quickSkippedLabel);
  await expect(quickSkippedRow).toContainText("skipped");
  await quickSkippedRow.getByRole("button", { name: "Restore" }).click();
  await expect(
    quickSkippedRow.getByRole("checkbox", {
      name: `Mark ${quickSkippedLabel} complete`,
      exact: true,
    }),
  ).toBeVisible();
  await waitForSaved(quickSkippedRow);

  const skippedLabel = PRODUCTION_WORKOUT_START_WARMUP[2].label;
  let skippedRow = warmupRow(reloadedPanel, skippedLabel);
  await skippedRow.getByRole("button", {
    name: "Other skip reason",
    exact: true,
  }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").selectOption("time_limit_reached");
  await dialog.getByLabel("Optional note").fill("Short session today");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(skippedRow.getByRole("button", { name: "Restore" })).toBeVisible();
  await waitForSaved(skippedRow);

  await page.reload({ waitUntil: "networkidle" });
  reloadedPanel = page.locator("#workout-warmup");
  await reloadedPanel
    .getByRole("button", { name: "Review full plan", exact: true })
    .click();
  skippedRow = warmupRow(reloadedPanel, skippedLabel);
  await expect(skippedRow).toContainText("Note: Short session today");
  await expect(skippedRow).toContainText("skipped");
  await skippedRow.getByRole("button", { name: "Restore" }).click();
  await expect(
    skippedRow.getByRole("checkbox", {
      name: `Mark ${skippedLabel} complete`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(skippedRow).toContainText("Note: Short session today");
  await waitForSaved(skippedRow);

  const actionButtons = page.locator("#workout-warmup li button");
  for (let index = 0; index < await actionButtons.count(); index += 1) {
    const box = await actionButtons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth + 1));

  const occurrenceId = (await completedRow.getAttribute("id"))?.replace(
    "warmup-occurrence-",
    "",
  );
  if (!occurrenceId) throw new Error("The warm-up occurrence has no stable ID.");
  await page.evaluate(
    ({ activeSessionId, activeOccurrenceId }) => {
      localStorage.setItem(
        "workout-tracker:occurrence-mutation-outbox:v1",
        JSON.stringify({
          version: 1,
          entries: [
            {
              clientKey: crypto.randomUUID(),
              ownerId: crypto.randomUUID(),
              sessionId: activeSessionId,
              occurrenceId: activeOccurrenceId,
              label: "Synthetic retained warm-up change",
              expectedRevision: 3,
              operation: "complete",
              reason: null,
              note: null,
              createdAtISO: new Date().toISOString(),
              status: "needs_attention",
              attemptCount: 6,
              nextAttemptAtISO: null,
              lastAttemptAtISO: new Date().toISOString(),
              lastError: "Synthetic offline failure",
            },
          ],
        }),
      );
    },
    { activeSessionId: sessionId, activeOccurrenceId: occurrenceId },
  );
  await page.goto("/today");
  const discard = page.getByRole("button", {
    name: "Discard this workout",
    exact: true,
  });
  await waitForHydratedReactHandler(discard);
  const foreignCopyBeforeDiscard = await page.evaluate(() =>
    localStorage.getItem("workout-tracker:occurrence-mutation-outbox:v1")
  );
  await discard.click();
  const discardDialog = page.getByRole("dialog", {
    name: /Discard .+\?/,
  });
  await expect(discardDialog.getByRole("note")).toContainText(
    "1 identified device copy belongs to another workout or account.",
  );
  await discardDialog
    .getByRole("button", { name: "Confirm discard" })
    .click();
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() =>
    localStorage.getItem("workout-tracker:occurrence-mutation-outbox:v1")
  )).toBe(foreignCopyBeforeDiscard);
  await pageErrors.expectNoUnexpected();
});
