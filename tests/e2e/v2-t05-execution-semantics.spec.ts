import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function signInAndStartDayA(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
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
  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  await alternateDays.getByRole("button", { name: /Day A — Squat/ }).click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function currentExerciseName(page: Page) {
  return page
    .getByTestId("current-exercise-card")
    .getByRole("heading", { level: 2 })
    .innerText();
}

async function addWorkoutOnlyExercise(page: Page, name: string) {
  const add = page.getByRole("button", {
    name: "Add exercise to this workout",
    exact: true,
  });
  await waitForHydratedReactHandler(add);
  await add.click();
  const picker = page.getByRole("dialog", {
    name: "Choose an exercise for this workout",
  });
  await picker.getByRole("textbox", { name: "Search exercise library" }).fill(name);
  await picker
    .getByRole("button", { name: `View details for ${name}`, exact: true })
    .click();
  await picker.getByRole("button", { name: "Review exercise", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Add exercise to this workout" });
  await review.getByRole("button", { name: "Add exercise", exact: true }).click();
  await expect(page.getByRole("region", { name })).toContainText("Workout only");
}

async function clickCentered(page: Page, locator: Locator) {
  const settleCenteredHitTest = async () => {
    await locator.evaluate((element) => {
      element.scrollIntoView({ block: "center", inline: "center" });
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      let unobstructedTop = 0;
      let unobstructedBottom = viewportHeight;
      for (const candidate of document.body.querySelectorAll<HTMLElement>("*")) {
        if (
          candidate === element ||
          candidate.contains(element) ||
          element.contains(candidate)
        ) continue;
        const position = getComputedStyle(candidate).position;
        if (position !== "fixed" && position !== "sticky") continue;
        const candidateRect = candidate.getBoundingClientRect();
        if (
          candidateRect.width <= 0 ||
          candidateRect.height <= 0 ||
          centerX < candidateRect.left ||
          centerX > candidateRect.right
        ) continue;
        const candidateCenter = candidateRect.top + candidateRect.height / 2;
        if (candidateCenter < viewportHeight / 2) {
          unobstructedTop = Math.max(unobstructedTop, candidateRect.bottom);
        } else {
          unobstructedBottom = Math.min(unobstructedBottom, candidateRect.top);
        }
      }
      const inset = rect.height / 2 + 8;
      const unobstructedCenter = Math.max(
        unobstructedTop + inset,
        Math.min(
          (unobstructedTop + unobstructedBottom) / 2,
          unobstructedBottom - inset,
        ),
      );
      window.scrollBy({
        top: rect.top + rect.height / 2 - unobstructedCenter,
        behavior: "instant",
      });
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        reachable: hit === element || (hit != null && element.contains(hit)),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
        blocker: hit instanceof HTMLElement
          ? {
              tag: hit.tagName,
              role: hit.getAttribute("role"),
              ariaLabel: hit.getAttribute("aria-label"),
              testId: hit.dataset.testid ?? null,
            }
          : null,
      };
    });
  };

  let hitTest = await settleCenteredHitTest();
  await expect.poll(async () => {
    hitTest = await settleCenteredHitTest();
    return hitTest.reachable;
  }, { timeout: 10_000 }).toBe(true);
  expect(hitTest.reachable, JSON.stringify(hitTest)).toBe(true);
  if (hitTest.coarsePointer) {
    await page.touchscreen.tap(hitTest.x, hitTest.y);
  } else {
    await page.mouse.click(hitTest.x, hitTest.y);
  }
}

async function skipCurrentSet(page: Page) {
  const current = page.getByTestId("current-exercise-card");
  const currentDisclosure = current.getByTestId("exercise-swipe-surface");
  await waitForHydratedReactHandler(currentDisclosure);
  await currentDisclosure.evaluate((element) => {
    if (element.getAttribute("aria-expanded") !== "true") {
      (element as HTMLElement).click();
    }
  });
  await expect(currentDisclosure).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const plannedEntry = current.getByTestId("current-set-entry");
  const currentEntry = (await plannedEntry.count()) === 1
    ? plannedEntry
    : current.getByTestId("added-set-entry");
  await expect(currentEntry).toHaveCount(1);
  const priorOccurrenceId = await currentEntry.getAttribute("id");
  expect(priorOccurrenceId).toMatch(/^(?:set-entry|added-set-entry)-/);
  const isPlannedEntry =
    (await currentEntry.getAttribute("data-testid")) === "current-set-entry";
  const skip = (isPlannedEntry
    ? current.getByTestId("current-set-secondary-actions")
    : currentEntry).getByRole("button", {
    name: "Skip set",
    exact: true,
  });
  await expect(skip).toBeEnabled();
  const dialog = page.getByRole("dialog", { name: /^Skip .+\?$/ });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForHydratedReactHandler(skip);
    try {
      await clickCentered(page, skip);
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      break;
    } catch (error) {
      if (await dialog.isVisible()) break;
      if (attempt === 1) throw error;
      await expect(skip).toBeEnabled({ timeout: 5_000 });
    }
  }
  await dialog.getByLabel("Reason").selectOption("time_limit_reached");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const nextCard = page.getByTestId("current-exercise-card");
    const nextPlannedEntry = nextCard.getByTestId("current-set-entry");
    const nextEntry = (await nextPlannedEntry.count()) === 1
      ? nextPlannedEntry
      : nextCard.getByTestId("added-set-entry");
    if ((await nextEntry.count()) === 1) {
      const nextOccurrenceId = await nextEntry.getAttribute("id");
      if (nextOccurrenceId != null && nextOccurrenceId !== priorOccurrenceId) {
        return true;
      }
    }
    const status = await page
      .getByRole("complementary", { name: "Workout status" })
      .innerText();
    const guidance = await page
      .getByRole("region", { name: "Workout progress and upcoming work" })
      .innerText();
    return status.includes("Ready to finish") &&
      guidance.includes("All actions resolved");
  }).toBe(true);
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review and finish workout|Finish workout)$/ })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: /^Discard .+\?$/ });
  await confirmation
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("moves keyboard focus off a rebound Log action during a held no-rest save", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  await signInAndStartDayA(page);
  for (let count = 0; count < 20; count += 1) {
    if ((await currentExerciseName(page)) === "Dumbbell Lateral Raise") break;
    await skipCurrentSet(page);
  }
  await expect(
    page
      .getByTestId("current-exercise-card")
      .getByRole("heading", { level: 2 }),
  ).toHaveText("Dumbbell Lateral Raise");

  let setRequests = 0;
  let releaseSave!: () => void;
  const saveMayFinish = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/session/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"setNo"')
    ) {
      setRequests += 1;
      if (setRequests === 1) await saveMayFinish;
    }
    await route.continue();
  });

  const firstLog = page.getByTestId("active-log-set");
  await expect(firstLog).toBeEnabled();
  const firstFormId = await firstLog.getAttribute("form");
  await firstLog.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => setRequests).toBe(1);
  await expect.poll(() => currentExerciseName(page)).toBe("Pallof Press");
  const nextEntry = page
    .getByTestId("current-exercise-card")
    .getByTestId("current-set-entry");
  const nextLog = page.getByTestId("active-log-set");
  const nextFormId = await nextLog.getAttribute("form");
  expect(nextFormId).not.toBe(firstFormId);
  await expect(nextEntry).toBeFocused();
  await expect(nextLog).not.toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(setRequests).toBe(1);

  releaseSave();
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (raw == null) return 0;
    return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
  })).toBe(0);
  await page.unrouteAll({ behavior: "wait" });
  await discardWorkout(page);
  await pageErrors.expectNoUnexpected();
});

test("keeps one ledger-driven current/next/group/rest state through retry, interruption, extra work, and finish readiness", async ({
  browserName,
  context,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName, [
    /500|Internal Server Error|Failed to load resource/i,
  ]);
  await signInAndStartDayA(page);
  const guidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  const status = page.getByRole("complementary", { name: "Workout status" });

  const first = page.getByTestId("current-exercise-card");
  await expect(first.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Barbell Back Squat, Set 1");
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await openNativeDetails(first.getByTestId("active-exercise-details"));
  const addExtra = first.getByRole("button", { name: "Add extra set", exact: true });
  await waitForHydratedReactHandler(addExtra);
  await addExtra.click();
  await expect(first.getByTestId("added-set-entry")).toContainText(
    "Extra set 1 · Added to this workout",
  );
  await addWorkoutOnlyExercise(page, "RKC Plank");
  await expect(first.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Barbell Back Squat, Set 1");

  const otherExercise = page.getByRole("region", { name: "Dumbbell Bench Press" });
  await otherExercise.getByTestId("exercise-swipe-surface").click();
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).toContainText("Next: Barbell Back Squat, set 2");
  const showCurrent = status.getByRole("button", {
    name: "Show Barbell Back Squat, Set 1",
    exact: true,
  });
  await expect(showCurrent).toContainText("Show current set");
  await showCurrent.click();
  await expect(
    page.getByTestId("current-exercise-card").getByTestId("exercise-swipe-surface"),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(status.getByTestId("active-workout-dock-primary"))
    .toHaveCount(0);
  await expect(page.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Barbell Back Squat, Set 1");

  for (let count = 0; count < 20; count += 1) {
    if ((await currentExerciseName(page)) === "Dumbbell Lateral Raise") break;
    await skipCurrentSet(page);
  }
  await expect(page.getByTestId("current-exercise-card").getByRole("heading", { level: 2 }))
    .toHaveText("Dumbbell Lateral Raise");
  const group = page.getByTestId("active-workout-group");
  await expect(group).toContainText("Current member: 1 of 2 · Dumbbell Lateral Raise");
  await expect(group).toContainText("Up next in group: 2 of 2 · Pallof Press");
  await expect(
    page.getByText("Set skip is saving.", { exact: true }).last(),
  ).not.toBeVisible();

  let setRequests = 0;
  let releaseRetry!: () => void;
  const retryMayFinish = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  await page.route("**/session/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"setNo"')
    ) {
      setRequests += 1;
      if (setRequests === 1) {
        await route.fulfill({ status: 500, body: "Injected T05 retry" });
        return;
      }
      if (setRequests === 2) await retryMayFinish;
    }
    await route.continue();
  });
  const currentLogSet = page.getByTestId("active-log-set");
  await expect(currentLogSet).toBeEnabled();
  await currentLogSet.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => setRequests).toBe(2);
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 1",
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(setRequests).toBe(2);
  await expect(
    page.getByRole("region", { name: "Dumbbell Lateral Raise" }),
  ).toContainText("Retrying");
  const retryCurrent = page.getByTestId("current-exercise-card");
  await expect(retryCurrent.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Pallof Press, Set 1");
  await expect(retryCurrent).toContainText("Next action");
  await expect(retryCurrent).toContainText(
    "Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
  );
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);
  await expect(page.getByTestId("active-log-set")).not.toBeFocused();

  const background = await context.newPage();
  await background.goto("about:blank");
  await background.bringToFront();
  releaseRetry();
  await page.bringToFront();
  await expect.poll(() => currentExerciseName(page)).toBe("Pallof Press");
  await background.close();
  await page.unrouteAll({ behavior: "wait" });
  await expect(group).toContainText("Current member: 2 of 2 · Pallof Press");
  await expect(group).toContainText("Round rest after this set: 1 min.");
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);

  await clickCentered(
    page,
    page.getByTestId("active-log-set"),
  );
  const rest = status.getByRole("region", { name: "Rest timer" });
  await expect(rest).toBeVisible();
  await expect(rest).toContainText(
    "Next: Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
  );
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await expect(group).toContainText("Round rest in progress.");
  await expect(group).toContainText("Next member: 1 of 2 · Dumbbell Lateral Raise");

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredStatus = page.getByRole("complementary", { name: "Workout status" });
  const restoredRest = restoredStatus.getByRole("region", {
    name: "Rest timer",
  });
  await expect(restoredRest).toBeVisible();
  await expect(restoredRest).toContainText(
    "Next: Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
  );
  await clickCentered(
    page,
    restoredStatus.getByRole("button", { name: "Skip rest", exact: true }),
  );
  await expect(
    restoredStatus.getByRole("button", { name: "Dismiss rest timer", exact: true }),
  ).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  const interruptedStatus = page.getByRole("complementary", { name: "Workout status" });
  await expect(interruptedStatus).toContainText("Rest complete");
  await clickCentered(
    page,
    interruptedStatus.getByRole("button", {
      name: "Dismiss rest timer",
      exact: true,
    }),
  );

  await skipCurrentSet(page);
  await expect.poll(() => currentExerciseName(page)).toBe("Pallof Press");
  await skipCurrentSet(page);
  await expect(guidance).not.toContainText("Now:");
  const currentExtraSet = page
    .getByTestId("current-exercise-card")
    .getByTestId("added-set-entry");
  await expect(currentExtraSet).toContainText(
    "Extra set 1 · Added to this workout",
  );
  await expect(currentExtraSet.getByTestId("inline-log-set")).toHaveCount(0);
  await expect(page.getByTestId("active-log-set")).toHaveCount(1);

  let finalSetRequests = 0;
  await page.route("**/session/**", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"setNo"')
    ) {
      finalSetRequests += 1;
      if (finalSetRequests === 1) {
        await route.fulfill({ status: 500, body: "Injected T05 final backoff" });
        return;
      }
    }
    await route.continue();
  });

  await clickCentered(
    page,
    page.getByTestId("active-log-set"),
  );
  await expect.poll(() => finalSetRequests).toBe(1);
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as {
      entries?: Array<{
        clientKey?: string;
        attemptCount?: number;
        nextAttemptAtISO?: string | null;
      }>;
    };
    const retained = parsed.entries?.[0];
    if (
      retained?.clientKey == null || retained.attemptCount !== 1 ||
      retained.nextAttemptAtISO == null
    ) return null;
    return retained.clientKey;
  })).not.toBeNull();
  const penultimateClientKey = await page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1")!;
    const parsed = JSON.parse(raw) as {
      entries: Array<{ clientKey: string; nextAttemptAtISO: string | null }>;
    };
    parsed.entries[0].nextAttemptAtISO = new Date(Date.now() + 60_000).toISOString();
    localStorage.setItem(
      "workout-tracker:workout-set-outbox:v1",
      JSON.stringify(parsed),
    );
    window.dispatchEvent(new Event("workout-set-outbox-change"));
    return parsed.entries[0].clientKey;
  });
  const finalRest = status.getByRole("region", { name: "Rest timer" });
  await expect(finalRest).toBeVisible();
  await expect(finalRest).toContainText("Next: RKC Plank, set 1");
  await finalRest.getByRole("button", { name: "Skip rest", exact: true }).click();
  await status
    .getByRole("button", { name: "Dismiss rest timer", exact: true })
    .click();
  await expect.poll(() => currentExerciseName(page)).toBe("RKC Plank");
  await page
    .getByTestId("current-exercise-card")
    .getByLabel("Duration in seconds")
    .fill("45");

  await clickCentered(
    page,
    page.getByTestId("active-log-set"),
  );
  await expect.poll(() => finalSetRequests).toBe(2);
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (raw == null) return [];
    const parsed = JSON.parse(raw) as { entries?: Array<{ clientKey?: string }> };
    return parsed.entries?.map((entry) => entry.clientKey) ?? [];
  })).toEqual([penultimateClientKey]);
  await expect.poll(async () => page.evaluate(() => {
    const outboxRaw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    const receiptRaw = localStorage.getItem(
      "workout-tracker:workout-rest-intent-receipts:v1",
    );
    if (outboxRaw == null || receiptRaw == null) return null;
    const outbox = JSON.parse(outboxRaw) as {
      entries?: Array<{ clientKey?: string }>;
    };
    const receipts = JSON.parse(receiptRaw) as {
      entries?: Array<{ clientKey?: string; restAfterSec?: number | null }>;
    };
    const retainedKey = outbox.entries?.[0]?.clientKey;
    const receipt = receipts.entries?.[0];
    return {
      retainedKey,
      receiptKey: receipt?.clientKey ?? null,
      restAfterSec: receipt?.restAfterSec,
      receiptIsLater: receipt?.clientKey != null && receipt.clientKey !== retainedKey,
    };
  })).toEqual({
    retainedKey: penultimateClientKey,
    receiptKey: expect.any(String),
    restAfterSec: null,
    receiptIsLater: true,
  });
  await expect(status).toContainText("Ready to finish");
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("All actions resolved");
  await expect(
    status.getByRole("button", {
      name: /^(?:Review and finish workout|Finish workout)$/,
    }),
  ).toBeVisible();
  await status
    .getByRole("button", { name: "Review and finish workout", exact: true })
    .click();
  const retainedFinish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(retainedFinish.getByText("1 set is still saving.")).toBeVisible();
  await expect(
    retainedFinish.getByRole("button", { name: "Save workout", exact: true }),
  ).toBeDisabled();
  await retainedFinish
    .getByRole("button", { name: "Back to workout", exact: true })
    .click();

  await page.unrouteAll({ behavior: "wait" });
  const recoveryPage = await context.newPage();
  const recoveryPageErrors = observeGauntletPageErrors(recoveryPage, browserName);
  await installNextDevelopmentRefreshControl(recoveryPage);
  await recoveryPage.goto(page.url(), { waitUntil: "domcontentloaded" });
  const recoveryStatus = recoveryPage.getByRole("complementary", {
    name: "Workout status",
  });
  await expect(recoveryStatus).toContainText("Ready to finish");
  await expect(recoveryStatus.getByLabel("Rest timer")).toHaveCount(0);
  const recoveryTray = recoveryPage.getByRole("button", {
    name: "Open sets waiting to save",
  });
  await waitForHydratedReactHandler(recoveryTray);
  await recoveryTray.click();
  const recoveryDrawer = recoveryPage.getByRole("dialog", {
    name: "Sets waiting to save",
  });
  await recoveryDrawer.getByRole("button", { name: "Retry save" }).click();
  await expect.poll(() => recoveryPage.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (raw == null) return 0;
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return parsed.entries?.length ?? 0;
  })).toBe(0);
  await expect.poll(() => recoveryPage.evaluate(() =>
    localStorage.getItem("workout-tracker:rest-timer:v1"),
  )).toBeNull();
  await expect.poll(() => recoveryPage.evaluate(() => {
    const raw = localStorage.getItem(
      "workout-tracker:workout-rest-intent-receipts:v1",
    );
    if (raw == null) return 0;
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return parsed.entries?.length ?? 0;
  })).toBe(0);
  await recoveryPageErrors.expectNoUnexpected();
  await recoveryPage.close();
  await expect(status).toContainText("Ready to finish");
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  const finalRestoredStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  await expect(finalRestoredStatus).toContainText("Ready to finish");
  await expect(finalRestoredStatus.getByLabel("Rest timer")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("workout-tracker:rest-timer:v1"),
  )).toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await discardWorkout(page);
  await pageErrors.expectNoUnexpected();
});
