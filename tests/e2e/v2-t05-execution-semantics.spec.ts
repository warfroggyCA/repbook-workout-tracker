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
  if ((await currentEntry.getAttribute("data-testid")) === "current-set-entry") {
    await openNativeDetails(currentEntry.locator("details", {
      hasText: "Set exceptions",
    }));
  }
  const skip = currentEntry.getByRole("button", {
    name: "Skip set",
    exact: true,
  });
  await expect(skip).toBeEnabled();
  await clickCentered(page, skip);
  const dialog = page.getByRole("dialog", { name: /^Skip .+\?$/ });
  await dialog.getByLabel("Reason").selectOption("time");
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
  await page.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: /^Discard .+\?$/ });
  await confirmation
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

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
  await expect(guidance).toContainText("Now: Barbell Back Squat, set 1");
  await first.locator("details", {
    hasText: "Extra sets",
  }).locator(":scope > summary").click();
  const addExtra = first.getByRole("button", { name: "Add extra set", exact: true });
  await waitForHydratedReactHandler(addExtra);
  await addExtra.click();
  await expect(first.getByTestId("added-set-entry")).toContainText(
    "Extra set 1 · Added to this workout",
  );
  await expect(guidance).toContainText("Now: Barbell Back Squat, set 1");

  const otherExercise = page.getByRole("region", { name: "Dumbbell Bench Press" });
  await otherExercise.getByTestId("exercise-swipe-surface").click();
  await expect(guidance).toContainText("Now: Barbell Back Squat, set 1");
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
    .toHaveAccessibleName("Log Barbell Back Squat, Set 1");

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
  await clickCentered(
    page,
    page
      .getByTestId("current-exercise-card")
      .getByRole("button", { name: "Log set", exact: true }),
  );
  await expect.poll(() => setRequests).toBe(2);
  await expect(
    page.getByRole("region", { name: "Dumbbell Lateral Raise" }),
  ).toContainText("Retrying");
  await expect(guidance).toContainText(
    /Now: Superset, round 1, member 2 of 2: Pallof Press, set 1/,
  );
  await expect(guidance).toContainText(
    /Next: Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2/,
  );
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);

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
    page
      .getByTestId("current-exercise-card")
      .getByRole("button", { name: "Log set", exact: true }),
  );
  await expect(status.getByLabel("Rest timer")).toBeVisible();
  await expect(guidance).toContainText(
    "Now: Resting before Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
  );
  await expect(guidance).toContainText(
    /Next: Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2/,
  );
  await expect(group).toContainText("Round rest in progress.");
  await expect(group).toContainText("Next member: 1 of 2 · Dumbbell Lateral Raise");

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredStatus = page.getByRole("complementary", { name: "Workout status" });
  await expect(restoredStatus.getByLabel("Rest timer")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText(
    "Now: Resting before Superset, round 2, member 1 of 2: Dumbbell Lateral Raise, set 2",
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
  await expect(interruptedStatus).toContainText("Ready");
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
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("Now: Barbell Back Squat, extra set 1");
  await expect(status).toContainText("Extra set 1");
  await clickCentered(
    page,
    page
      .getByTestId("current-exercise-card")
      .getByRole("button", { name: "Log set", exact: true }),
  );
  await expect(status).toContainText("Ready to finish");
  await expect(status.getByLabel("Rest timer")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workout progress and upcoming work" }),
  ).toContainText("All actions resolved");
  await expect(page.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await discardWorkout(page);
  await pageErrors.expectNoUnexpected();
});
