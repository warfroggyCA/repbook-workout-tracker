import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";
import {
  openNativeDetails,
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
  if (!(await extraLarge.isChecked())) await extraLarge.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");

  await page.goto("/today");
  await expect(page.locator('a[href="/simulation"]')).toHaveCount(0);
  await page.goto("/program");
  await expect(page.locator('a[href="/simulation"]')).toHaveCount(0);
  const warmupDetails = page.locator("details").filter({
    has: page.getByText("Warm-up", { exact: true }),
  });
  const warmupSummary = warmupDetails.locator(":scope > summary");
  await expect(warmupSummary).toContainText(/\d+ instructions?/);
  await expect(warmupDetails).not.toHaveAttribute("open", "");
  await warmupSummary.click();
  await expect(warmupDetails).toHaveAttribute("open", "");
  await expect(
    warmupDetails.getByText(
      BA_WORKOUT_FIXTURE.program.days[0].warmupNotes,
      { exact: true },
    ),
  ).toBeVisible();
  await page.goto("/today");
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await page.locator("summary").filter({ hasText: "Workout options" }).click();
  await page.getByRole("checkbox", { name: /Include programmed warm-ups/ }).check();
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

function exerciseCard(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true });
}

async function expectReachableTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(async () => {
    await locator.evaluate((element) =>
      element.scrollIntoView({ behavior: "auto", block: "center", inline: "center" })
    );
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        height: rect.height,
        width: rect.width,
        hit: hit === element || (hit != null && element.contains(hit)),
      };
    });
    expect(result).toMatchObject({ hit: true });
    expect(result.height).toBeGreaterThanOrEqual(44);
    expect(result.width).toBeGreaterThanOrEqual(44);
  }).toPass();
}

async function expectActiveViewportBudget(
  page: Page,
  requireCompactBackInViewport = false,
) {
  const hasCompactBackControl =
    (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 440;
  await expect(
    page.getByRole("region", {
      name: "Workout progress and upcoming work",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Workout status" }),
  ).toBeVisible();
  await expect(page.getByTestId("contextual-note-trigger")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Review notes", exact: true }),
  ).toBeHidden();
  if (hasCompactBackControl) {
    await expect(
      page.getByRole("link", { name: "Back to Today", exact: true }),
    ).toBeVisible();
  }
  await expect(async () => {
    const budget = await page.evaluate(() => {
      const guidance = document.querySelector<HTMLElement>(
        'section[aria-label="Workout progress and upcoming work"]',
      );
      const dock = document.querySelector<HTMLElement>("#workout-rest-status");
      if (!guidance || !dock) {
        throw new Error("Active workout boundaries are missing.");
      }
      const guidanceRect = guidance.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const navigation = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary navigation"]',
      );
      const navigationRect = navigation?.getBoundingClientRect() ?? null;
      const backControl = document.querySelector<HTMLElement>(
        'a[aria-label="Back to Today"]',
      );
      const backControlRect = backControl?.getBoundingClientRect() ?? null;
      const intrusions = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) =>
          element !== dock &&
          element !== navigation &&
          !element.contains(guidance) &&
          !dock.contains(element) &&
          !(navigation?.contains(element) ?? false)
        )
        .filter((element) => {
          const style = getComputedStyle(element);
          if (style.position !== "fixed" && style.position !== "sticky") {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width >= window.innerWidth * 0.7 &&
            rect.bottom > guidanceRect.bottom + 1 &&
            rect.top < dockRect.top - 1;
        })
        .map((element) =>
          element.id || element.getAttribute("aria-label") || element.tagName
        );
      return {
        usableHeight: Math.max(0, dockRect.top - guidanceRect.bottom),
        dockClearsNavigation:
          navigationRect == null || navigationRect.height === 0 ||
          dockRect.bottom <= navigationRect.top + 1,
        intrusions,
        horizontalOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        backControlInsideViewport: backControlRect == null
          ? null
          : backControlRect.left >= 0 &&
            backControlRect.top >= 0 &&
            backControlRect.right <= window.innerWidth + 1 &&
            backControlRect.bottom <= window.innerHeight + 1,
      };
    });
    expect(budget.usableHeight).toBeGreaterThanOrEqual(280);
    expect(budget.dockClearsNavigation).toBe(true);
    expect(budget.intrusions).toEqual([]);
    expect(budget.horizontalOverflow).toBeLessThanOrEqual(1);
    if (hasCompactBackControl && requireCompactBackInViewport) {
      expect(budget.backControlInsideViewport).toBe(true);
    }
  }).toPass();
}

async function dismissRest(page: Page) {
  const status = page.getByRole("complementary", { name: "Workout status" });
  const skip = status.getByRole("button", { name: "Skip rest", exact: true });
  await expect(skip).toBeVisible();
  await expectActiveViewportBudget(page);
  await skip.click();
  const dismiss = status.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await expectActiveViewportBudget(page);
  await dismiss.click();
  await expect(dismiss).toHaveCount(0);
}

async function openMoreForExercise(card: Locator) {
  const details = card.locator("details", { hasText: "More for this exercise" });
  await openNativeDetails(details);
}

async function skipForEquipment(card: Locator, page: Page) {
  await openMoreForExercise(card);
  await card.getByRole("button", { name: "Skip exercise", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Skip exercise — why?" });
  await dialog
    .getByRole("button", {
      name: "Equipment unavailable or incompatible",
      exact: true,
    })
    .click();
  await expect(card.getByRole("status")).toContainText("Exercise skipped");
}

test("keeps the full live workout usable through warm-up, skip, replace, continue, and finish", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName, [
    /500|Internal Server Error|Failed to load resource/i,
  ]);
  await signInAndStart(page);
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 440) {
    const workoutExit = page.getByRole("link", {
      name: "Back to Today",
      exact: true,
    });
    await expect(workoutExit).toHaveCount(1);
    await expect(workoutExit).toBeVisible();
  }

  const warmup = page.locator("#workout-warmup");
  await expect(warmup).toContainText("Complete the current warm-up action below.");
  await expect(page.getByText(
    BA_WORKOUT_FIXTURE.program.days[0].warmupNotes,
    { exact: true },
  )).not.toBeVisible();
  expect(await warmup.evaluate((element) => getComputedStyle(element).position))
    .not.toMatch(/fixed|sticky/);
  await expectActiveViewportBudget(page, true);

  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 320) {
    const originalViewport = page.viewportSize();
    await page
      .getByRole("complementary", { name: "Workout status" })
      .getByRole("button", { name: "Add training note", exact: true })
      .click();
    const noteDialog = page.getByRole("dialog", {
      name: "Add a training note",
    });
    await expect(noteDialog).toBeVisible();
    const observation = noteDialog.getByRole("textbox", {
      name: "Your observation",
    });
    await observation.fill("Keyboard viewport acceptance draft");
    const noteActions = noteDialog.getByRole("group", {
      name: "Note actions",
    });
    const saveNote = noteActions.getByRole("button", {
      name: "Save note",
      exact: true,
    });
    await expect(noteActions).toBeVisible();
    await page.setViewportSize({ width: 320, height: 400 });
    await expect(observation).toBeFocused();
    await expect(saveNote).toBeInViewport();
    await expectReachableTarget(saveNote);
    const closeDraft = noteActions.getByRole("button", {
      name: "Close · keep draft",
      exact: true,
    });
    await expect(closeDraft).toBeInViewport();
    await expectReachableTarget(closeDraft);
    await noteDialog.getByRole("button", { name: "Start dictation" }).scrollIntoViewIfNeeded();
    await expect(saveNote).toBeInViewport();
    await expectReachableTarget(saveNote);
    await closeDraft.scrollIntoViewIfNeeded();
    await expectReachableTarget(closeDraft);
    await closeDraft.click();
    await expect(noteDialog).toHaveCount(0);
    if (originalViewport) await page.setViewportSize(originalViewport);
    await expectActiveViewportBudget(page);
  }

  for (const [index, action] of PRODUCTION_WORKOUT_START_WARMUP.entries()) {
    const checkbox = warmup.getByRole("checkbox", {
      name: `Mark ${action.label} complete`,
      exact: true,
    });
    await expectReachableTarget(checkbox);
    await checkbox.click();
    const completedLastAction =
      index === PRODUCTION_WORKOUT_START_WARMUP.length - 1;
    if (completedLastAction) {
      await expect(warmup).toContainText("Warm-up actions are accounted for.");
    } else {
      const nextAction = PRODUCTION_WORKOUT_START_WARMUP[index + 1];
      await expect(
        warmup.getByRole("checkbox", {
          name: `Mark ${nextAction.label} complete`,
          exact: true,
        }),
      ).toBeVisible();
    }
  }

  expect(
    BA_WORKOUT_FIXTURE.equipment.items
      .map((item) => String(item.type))
      .includes("suspension"),
  ).toBe(false);
  let incompatible = exerciseCard(page, "Suspension Push-Up");
  if (
    (await incompatible.getByTestId("exercise-swipe-surface").getAttribute("aria-expanded")) !==
    "true"
  ) {
    await incompatible.getByTestId("exercise-swipe-surface").click();
  }
  let releaseInterruptedSkip!: () => void;
  const interruptedSkipMayFinish = new Promise<void>((resolve) => {
    releaseInterruptedSkip = resolve;
  });
  let confirmInterruptedSkipSettled!: () => void;
  const interruptedSkipSettled = new Promise<void>((resolve) => {
    confirmInterruptedSkipSettled = resolve;
  });
  let confirmInterruptedSkipTransportSettled!: () => void;
  const interruptedSkipTransportSettled = new Promise<void>((resolve) => {
    confirmInterruptedSkipTransportSettled = resolve;
  });
  let firstInterruptedSkipRequest: Request | null = null;
  const observeInterruptedSkipTransport = (request: Request) => {
    if (request === firstInterruptedSkipRequest) {
      confirmInterruptedSkipTransportSettled();
    }
  };
  page.on("requestfailed", observeInterruptedSkipTransport);
  page.on("requestfinished", observeInterruptedSkipTransport);
  let interruptedSkipRequests = 0;
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const postData = request.postData() ?? "";
    if (
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      postData.includes('"reason":"equipment_unavailable_incompatible"')
    ) {
      interruptedSkipRequests += 1;
      if (interruptedSkipRequests === 1) {
        firstInterruptedSkipRequest = request;
        await interruptedSkipMayFinish;
        try {
          await route.abort("failed");
        } finally {
          confirmInterruptedSkipSettled();
        }
        return;
      }
    }
    await route.continue().catch(() => undefined);
  });
  await openMoreForExercise(incompatible);
  await incompatible
    .getByRole("button", { name: "Skip exercise", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Skip exercise — why?" })
    .getByRole("button", {
      name: "Equipment unavailable or incompatible",
      exact: true,
    })
    .click();
  await expect.poll(() => interruptedSkipRequests).toBe(1);
  await expect.poll(() => page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("workout-tracker:skip-recovery:v1:")
    ).length
  )).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {
    name: "Skip exercise — why?",
  })).toHaveCount(0);
  const interruptedSessionPathname = new URL(page.url()).pathname;
  const interruptedWorkoutExit =
    (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 440
      ? page.getByRole("link", { name: "Back to Today", exact: true })
      : page
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("link", { name: "Today", exact: true });
  await expect(interruptedWorkoutExit).toBeVisible();
  await interruptedWorkoutExit.click();
  await expect(page).toHaveURL(/\/today$/);
  releaseInterruptedSkip();
  await Promise.all([
    interruptedSkipSettled,
    interruptedSkipTransportSettled,
  ]);
  await page.context().unrouteAll({ behavior: "wait" });
  await expect.poll(() => page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("workout-tracker:skip-recovery:v1:")
    ).length
  )).toBe(1);
  await page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith("workout-tracker:skip-recovery:v1:")
    );
    if (key == null) throw new Error("Missing interrupted-skip recovery marker.");
    const raw = window.sessionStorage.getItem(key);
    if (raw == null) throw new Error("Missing interrupted-skip recovery value.");
    const marker = JSON.parse(raw) as { expectedHistoryRevision?: unknown };
    if (typeof marker.expectedHistoryRevision !== "number") {
      throw new Error("Missing interrupted-skip history revision.");
    }
    marker.expectedHistoryRevision += 10_000;
    window.sessionStorage.setItem(key, JSON.stringify(marker));
  });
  const resumeInterruptedWorkout = page.getByRole("button", {
    name: "Resume workout",
    exact: true,
  });
  await expect(resumeInterruptedWorkout).toBeVisible();
  await resumeInterruptedWorkout.click();
  await expect.poll(() => page.evaluate(() => ({
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search,
  }))).toEqual({
    hash: "",
    pathname: interruptedSessionPathname,
    search: "",
  });
  await expect.poll(() => page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("workout-tracker:skip-recovery:v1:")
    ).length
  )).toBe(1);
  incompatible = exerciseCard(page, "Suspension Push-Up");
  await expect(incompatible).toContainText("Skip was not confirmed");
  const failedSkipRecovery = page.getByRole("button", {
    name: "Resolve Suspension Push-Up",
  });
  await expectReachableTarget(failedSkipRecovery);
  await expect(failedSkipRecovery).toContainText("Review or try again");
  await expect(page.getByRole("button", { name: /^Log / })).toHaveCount(0);
  await expect(incompatible).toContainText(
    "equipment unavailable or incompatible skip",
  );
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.sessionStorage).find((candidate) =>
      candidate.startsWith("workout-tracker:skip-recovery:v1:")
    );
    return key == null ? null : window.sessionStorage.getItem(key);
  })).toContain('"phase":"unconfirmed"');
  await page.reload({ waitUntil: "networkidle" });
  incompatible = exerciseCard(page, "Suspension Push-Up");
  await expect(incompatible).toContainText("Skip was not confirmed");
  await expect(incompatible).toContainText(
    "equipment unavailable or incompatible skip",
  );
  await expect.poll(() => interruptedSkipRequests).toBe(1);
  await expect(page.getByRole("button", { name: /^Log / })).toHaveCount(0);
  const rehydratedFailedSkipRecovery = page.getByRole("button", {
    name: "Resolve Suspension Push-Up",
  });
  await expectReachableTarget(rehydratedFailedSkipRecovery);
  await expect(rehydratedFailedSkipRecovery).toContainText(
    "Review or try again",
  );
  await rehydratedFailedSkipRecovery.click();
  await expect(
    incompatible.getByRole("button", { name: "Try skipping again" }),
  ).toBeFocused();
  await incompatible
    .getByRole("button", { name: "Try skipping again" })
    .click();
  await page
    .getByRole("dialog", { name: "Skip exercise — why?" })
    .getByRole("button", {
      name: "Equipment unavailable or incompatible",
      exact: true,
    })
    .click();
  await expect(incompatible.getByRole("status")).toContainText(
    "Exercise skipped",
  );
  await expect(page.getByRole("button", { name: /^Log / })).toHaveCount(0);
  const resolveSkippedExercise = page.getByRole("button", {
    name: "Resolve Suspension Push-Up",
  });
  await expectReachableTarget(resolveSkippedExercise);
  await expect(resolveSkippedExercise).toContainText("Replace or continue");
  const replace = incompatible.getByRole("button", {
    name: "Replace exercise",
    exact: true,
  });
  const continueWithout = incompatible.getByRole("button", {
    name: "Continue without replacement",
    exact: true,
  });
  await expectReachableTarget(replace);
  await expectReachableTarget(continueWithout);
  await expectActiveViewportBudget(page);

  const finishEarly = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: "Review and finish workout", exact: true });
  await expect(finishEarly).toContainText("Review");
  await finishEarly.click();
  const earlyFinishReview = page.getByRole("dialog", {
    name: "Finish workout",
  });
  await expect(earlyFinishReview).toContainText("Choose one reason for all");
  await expect(earlyFinishReview).toContainText(
    "you do not need to skip sets or exercises one at a time",
  );
  await expect(earlyFinishReview).not.toContainText(
    "Resolve the skipped exercise",
  );
  await earlyFinishReview
    .getByRole("button", { name: "Back to workout", exact: true })
    .click();

  await continueWithout.click();
  await expect(resolveSkippedExercise).toHaveCount(0);
  await expect(
    page.getByTestId("active-log-set"),
  ).toBeVisible();
  await expect(
    exerciseCard(page, "Barbell Back Squat").getByTestId("exercise-swipe-surface"),
  ).toHaveAttribute("aria-expanded", "true");
  await expectActiveViewportBudget(page);

  const completedSquat = exerciseCard(page, "Barbell Back Squat");
  for (let setNo = 1; setNo <= 3; setNo += 1) {
    const current = page.getByTestId("current-exercise-card");
    const currentSet = current.getByTestId("current-set-entry");
    await expect(currentSet).toContainText(`Set ${setNo}`);
    const log = page.getByTestId("active-log-set");
    await expectReachableTarget(log);
    await log.click();
    if (setNo === 3) {
      await expect(completedSquat).toContainText("3/3 planned performed");
      const completedSquatToggle = completedSquat.getByTestId("exercise-swipe-surface");
      await expect(completedSquatToggle).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await completedSquatToggle.click();
    }
    const receipt = completedSquat.getByTestId("completed-sets");
    await expect(receipt).toContainText(`Set ${setNo}`);
    await expect(receipt).toContainText("Acknowledged by Repbook");
    await dismissRest(page);
    await expectActiveViewportBudget(page);
  }

  await expect(
    exerciseCard(page, "Dumbbell Lateral Raise").getByTestId("exercise-swipe-surface"),
  ).toHaveAttribute("aria-expanded", "true");

  incompatible = exerciseCard(page, "Suspension Push-Up");
  await incompatible.getByTestId("exercise-swipe-surface").click();
  const unskip = incompatible.getByRole("button", { name: "Un-skip", exact: true });
  await unskip.click();
  await expect(unskip).toHaveCount(0);
  await openMoreForExercise(incompatible);
  await expect(
    incompatible.getByRole("button", { name: "Skip exercise", exact: true }),
  ).toBeVisible();
  await skipForEquipment(incompatible, page);
  await expect(
    page.getByRole("dialog", { name: "Skip exercise — why?" }),
  ).toHaveCount(0);
  const replaceSkippedExercise = incompatible.getByRole("button", {
    name: "Replace exercise",
    exact: true,
  });
  await expect(replaceSkippedExercise).toBeEnabled();
  await expectReachableTarget(replaceSkippedExercise);
  let replacementCatalogRequests = 0;
  let releaseClosedCatalog!: () => void;
  const closedCatalogMayFinish = new Promise<void>((resolve) => {
    releaseClosedCatalog = resolve;
  });
  let releaseTimedOutCatalog!: () => void;
  const timedOutCatalogMayFinish = new Promise<void>((resolve) => {
    releaseTimedOutCatalog = resolve;
  });
  await page.route("**/api/session/exercise-options?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("mode") !== "replacement") {
      await route.continue().catch(() => undefined);
      return;
    }
    replacementCatalogRequests += 1;
    if (replacementCatalogRequests === 1) {
      await closedCatalogMayFinish;
      await route.abort("failed").catch(() => undefined);
      return;
    }
    if (replacementCatalogRequests === 2) {
      await timedOutCatalogMayFinish;
      await route.abort("failed").catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
  await replaceSkippedExercise.click();
  const replacementDrawer = page.getByRole("dialog", {
    name: "Replace exercise for this workout",
  });
  await expect(replacementDrawer).toContainText("Loading exercise catalog");
  await replacementDrawer
    .getByRole("button", { name: "Back to workout", exact: true })
    .click();
  await expect(replacementDrawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Resolve Suspension Push-Up" }),
  ).toBeVisible();
  const catalogRecoveryExit =
    (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 440
      ? page.getByRole("link", { name: "Back to Today", exact: true })
      : page
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("link", { name: "Today", exact: true });
  await expect(catalogRecoveryExit).toBeVisible();
  await expect(catalogRecoveryExit).toHaveAttribute("href", "/today");
  releaseClosedCatalog();
  await incompatible
    .getByRole("button", { name: "Replace exercise", exact: true })
    .click();
  await expect.poll(() => replacementCatalogRequests).toBe(2);
  await expect(replacementDrawer).toContainText("Catalog unavailable");
  const retryCatalog = replacementDrawer.getByRole("button", {
    name: "Try loading catalog again",
    exact: true,
  });
  await expectReachableTarget(retryCatalog);
  await retryCatalog.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => replacementCatalogRequests).toBe(3);
  const searchCatalog = replacementDrawer.getByRole("button", {
    name: "Search exercise catalog",
    exact: true,
  });
  await expect(searchCatalog).toBeVisible();
  releaseTimedOutCatalog();
  await page.unrouteAll({ behavior: "wait" });
  const equipmentBusy = replacementDrawer.getByRole("button", {
    name: "Equipment busy",
    exact: true,
  });
  await expect(equipmentBusy).toBeEnabled();
  await equipmentBusy.click();
  await searchCatalog.click();
  const picker = page.getByRole("dialog", { name: "Replace exercise", exact: true });
  await picker.getByLabel("Search exercise library").fill("Push-Up");
  await picker
    .getByRole("button", { name: "View details for Push-Up", exact: true })
    .click();
  await picker
    .getByRole("button", { name: "Replace in this workout", exact: true })
    .click();

  const replacement = exerciseCard(page, "Push-Up");
  await expect(replacement).toContainText("instead of Suspension Push-Up");
  await expect(replacement).not.toContainText("Exercise skipped");
  await expectActiveViewportBudget(page);

  const replacementSet = replacement.getByTestId("current-set-entry");
  await expect(replacementSet).toContainText("Set 1");
  const logReplacement = page.getByTestId("active-log-set");
  await expectReachableTarget(logReplacement);
  await logReplacement.click();
  await expect(replacement.getByTestId("completed-sets"))
    .toContainText("1 completed");
  await expect(
    page.getByRole("complementary", { name: "Workout status" })
      .getByRole("button", { name: "Skip rest", exact: true }),
  ).toBeVisible();
  await expectActiveViewportBudget(page);

  const finish = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review and finish workout|Finish workout)$/ });
  await expectReachableTarget(finish);
  await finish.click();
  const finishDialog = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finishDialog).toBeVisible();
  await expect
    .poll(() =>
      finishDialog.evaluate(
        (dialog) =>
          dialog.getBoundingClientRect().bottom <= window.innerHeight + 1,
      ),
    )
    .toBe(true);
  const finishGeometry = await finishDialog.evaluate((dialog) => {
    const scrollRegion = dialog.querySelector<HTMLElement>(
      '[data-testid="finish-workout-scroll"]',
    );
    const footer = dialog.querySelector<HTMLElement>(
      '[data-slot="drawer-footer"]',
    );
    if (!scrollRegion || !footer) {
      throw new Error("Finish workout scroll or action region is missing.");
    }
    const footerRect = footer.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(scrollRegion).overflowY,
      footerTop: footerRect.top,
    };
  });
  expect(finishGeometry.overflowY).toBe("auto");
  expect(finishGeometry.footerTop).toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      finishDialog.evaluate((dialog) => {
        const footer = dialog.querySelector<HTMLElement>(
          '[data-slot="drawer-footer"]',
        );
        return footer != null &&
          footer.getBoundingClientRect().bottom <= window.innerHeight + 1;
      }),
    )
    .toBe(true);
  const save = finishDialog.getByRole("button", {
    name: /^(?:Finish early|Save workout)$/,
  });
  await finishDialog
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await expectReachableTarget(save);
  await save.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await pageErrors.expectNoUnexpected();
});
