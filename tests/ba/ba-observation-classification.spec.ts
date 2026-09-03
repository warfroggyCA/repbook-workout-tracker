import {
  expect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  BA_WORKOUT_EMAIL,
  BA_WORKOUT_FIXTURE,
} from "../fixtures/ba-workout-contract";
import {
  writeBaCheckpointAudit,
  type BaCheckpointArtifact,
  type BaCheckpointSeverity,
  type BaCheckpointStatus,
  type BaDeviceCalibration,
} from "../helpers/ba-audit";
import {
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

type Classification = "pass" | "reproduced" | "not-testable" | "changed";
type CapturedRequest = {
  method: string;
  url: string;
  reason: string;
  status?: number | null;
};

function auditStatus(classification: Classification): BaCheckpointStatus {
  if (classification === "pass") return "pass";
  if (classification === "not-testable") return "blocked";
  return "fail";
}

async function discardActiveWorkout(page: Page) {
  await page.goto("/today");
  const discard = page.getByRole("button", {
    name: "Discard this workout",
    exact: true,
  });
  if ((await discard.count()) === 0) return;
  await waitForHydratedReactHandler(discard);
  await discard.click();
  const confirm = page.getByRole("button", {
    name: "Confirm discard",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await waitForHydratedReactHandler(confirm);
  await confirm.click();
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true }),
  ).toBeVisible();
}

test("classifies all sixteen prior workout observations", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: CapturedRequest[] = [];
  const cancelled = /ERR_ABORTED|NS_BINDING_ABORTED|cancelled|due to access control checks/i;

  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !cancelled.test(text)) {
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => {
    if (!cancelled.test(error.message)) pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown failure";
    if (cancelled.test(reason)) return;
    failedRequests.push({ method: request.method(), url: request.url(), reason });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    failedRequests.push({
      method: response.request().method(),
      url: response.url(),
      reason: `Unexpected HTTP ${response.status()} response`,
      status: response.status(),
    });
  });

  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  await page.waitForLoadState("networkidle");

  const calibration: BaDeviceCalibration = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height },
    deviceScaleFactor: devicePixelRatio,
    mobile: /iPhone/.test(navigator.userAgent),
    touch: navigator.maxTouchPoints > 0 || "ontouchstart" in window,
    touchPoints: navigator.maxTouchPoints,
    userAgent: navigator.userAgent,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  expect(calibration).toMatchObject({
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    timezone: "America/Toronto",
  });

  async function record(input: {
    number: number;
    classification: Classification;
    severity: BaCheckpointSeverity;
    action: string;
    expected: string;
    observed: string;
    followUp?: string;
    fullPage?: boolean;
    additionalArtifacts?: BaCheckpointArtifact[];
  }) {
    const checkpointId = `QA-04-OBS-${String(input.number).padStart(2, "0")}`;
    const screenshot = testInfo.outputPath(`${checkpointId}.png`);
    await page.screenshot({ path: screenshot, fullPage: input.fullPage });
    await writeBaCheckpointAudit({
      evidenceRoot: testInfo.outputDir,
      attach: (name, options) => testInfo.attach(name, options),
      audit: {
        checkpointId,
        preconditions:
          "Fresh disposable BA workout fixture; deterministic fake Coach; public UI only.",
        action: input.action,
        expected: input.expected,
        observed: `Classification: ${input.classification}. ${input.observed}`,
        status: auditStatus(input.classification),
        severity: input.severity,
        url: page.url(),
        calibration,
        consoleErrors: [...consoleErrors],
        pageErrors: [...pageErrors],
        failedRequests: [...failedRequests],
        followUp: input.followUp ?? "Retain this classification for the twice-run QA-04 comparison.",
        artifacts: [
          {
            label: `Observation ${input.number} checkpoint`,
            kind: "screenshot",
            path: screenshot,
          },
          ...(input.additionalArtifacts ?? []),
        ],
      },
    });
  }

  async function resetHorizontalScroll() {
    await page.evaluate(() => window.scrollTo(0, window.scrollY));
  }

  async function settleEvidenceFrame() {
    await resetHorizontalScroll();
    await page.waitForTimeout(400);
  }

  async function visibleCount(locator: Locator) {
    const matches = await locator.all();
    const visibility = await Promise.all(
      matches.map((match) => match.isVisible().catch(() => false)),
    );
    return visibility.filter(Boolean).length;
  }

  async function waitForStableElement(locator: Locator) {
    await expect(locator).toBeVisible();
    let previous = "";
    await expect
      .poll(
        async () => {
          const frame = await locator.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return JSON.stringify({
              x: Math.round(box.x * 10) / 10,
              y: Math.round(box.y * 10) / 10,
              width: Math.round(box.width * 10) / 10,
              height: Math.round(box.height * 10) / 10,
              opacity: getComputedStyle(element).opacity,
            });
          });
          const stable = frame === previous && JSON.parse(frame).opacity === "1";
          previous = frame;
          return stable;
        },
        { intervals: [100, 100, 150, 200], timeout: 3_000 },
      )
      .toBe(true);
  }

  try {
    const simulationModeCount = await visibleCount(
      page.getByText(/\b(?:preview|practice|simulation) mode\b/i),
    );
    await record({
      number: 16,
      classification: simulationModeCount > 0 ? "changed" : "reproduced",
      severity: "medium",
      action: "Inspect Today for a user-visible workout Preview, Practice, or Simulation mode.",
      expected: "A safe simulation mode is unmistakable and separate from normal workout storage.",
      observed:
        simulationModeCount > 0
          ? "A simulation-labelled surface exists and needs an isolation audit."
          : "No user-visible Preview, Practice, or Simulation mode exists. The planned-exercise preview is not a workout simulation mode.",
    });

    const alternateDays = page.getByTestId("alternate-program-days");
    await alternateDays.locator("summary").click();
    const previewDayB = alternateDays.getByRole("button", {
      name: /Day B — Hinge and recovery/,
    });
    await previewDayB.click();
    const startDayB = page.getByRole("button", {
      name: "Start workout",
      exact: true,
    });
    await waitForHydratedServerAction(startDayB);
    await startDayB.click();
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

    const dock = page.locator('section[id^="exercise-"]').filter({
      has: page.getByRole("button", { name: "Log set", exact: true }),
    });
    async function selectExercise(name: string) {
      const targetHeading = dock.getByRole("heading", { name, exact: true });
      if (await targetHeading.isVisible()) return;
      const card = page
        .locator('[id^="exercise-"]')
        .filter({ has: page.getByRole("heading", { name, exact: true }) })
        .first();
      await card.locator(":scope > button").click();
      await expect(targetHeading).toBeVisible();
    }
    await selectExercise("Band Lat Pulldown");
    await expect(dock.getByRole("heading", { name: "Band Lat Pulldown" })).toBeVisible();
    const bandLoadInputs = await dock.getByLabel(/^(?:Total load|Load)$/).count();
    await record({
      number: 5,
      classification: "not-testable",
      severity: "high",
      action: "Open the fixture's Lat Pulldown occurrence and inspect its load controls.",
      expected: "The owner's plate-loaded Lat Pulldown exposes an independently checkable per-side calculator.",
      observed: `The fixture Program contains Band Lat Pulldown with ${bandLoadInputs} load inputs, not the owner's plate-loaded machine occurrence. A per-side machine calculator cannot be classified from this workout.`,
    });

    await selectExercise("EZ-Bar Curl");
    await expect(dock.getByRole("heading", { name: "EZ-Bar Curl" })).toBeVisible();
    const ezLoad = dock.getByLabel("Total load", { exact: true });
    const ezLoadVisible = await ezLoad.isVisible();
    const initialEzValue = ezLoadVisible ? await ezLoad.inputValue() : "missing";
    const ezBeforeScreenshot = testInfo.outputPath("QA-04-OBS-15-before-increment.png");
    await settleEvidenceFrame();
    await page.screenshot({ path: ezBeforeScreenshot });
    const decreaseEzLoad = dock.getByRole("button", {
      name: "Decrease load",
      exact: true,
    });
    const increaseEzLoad = dock.getByRole("button", {
      name: "Increase load",
      exact: true,
    });
    const ezControlsVisible =
      ezLoadVisible &&
      (await decreaseEzLoad.isVisible()) &&
      (await increaseEzLoad.isVisible());
    if (ezControlsVisible) {
      await decreaseEzLoad.click();
      await page.waitForTimeout(100);
    }
    const floorValue = ezLoadVisible ? await ezLoad.inputValue() : "missing";
    const emptyBarGuidance = await visibleCount(
      dock.getByText("Empty bar and collars: 18 lb", { exact: true }),
    );

    if (ezControlsVisible) {
      await increaseEzLoad.click();
      await page.waitForTimeout(100);
    }
    const firstValue = ezLoadVisible ? await ezLoad.inputValue() : "missing";
    const firstGuidance = await visibleCount(
      dock.getByText("Per side: 1.25", { exact: true }),
    );
    const ezFirstScreenshot = testInfo.outputPath("QA-04-OBS-15-20-5-lb.png");
    await page.screenshot({ path: ezFirstScreenshot });

    if (ezControlsVisible) {
      await increaseEzLoad.click();
      await page.waitForTimeout(100);
    }
    const secondValue = ezLoadVisible ? await ezLoad.inputValue() : "missing";
    const secondGuidance = await visibleCount(
      dock.getByText("Per side: 2.5", { exact: true }),
    );
    const ezSecondScreenshot = testInfo.outputPath("QA-04-OBS-15-23-lb.png");
    await page.screenshot({ path: ezSecondScreenshot });

    if (ezControlsVisible) {
      await increaseEzLoad.click();
      await page.waitForTimeout(100);
    }
    const thirdValue = ezLoadVisible ? await ezLoad.inputValue() : "missing";
    const thirdGuidance = await visibleCount(
      dock.getByText("Per side: 2.5 + 1.25", { exact: true }),
    );
    await settleEvidenceFrame();
    const ezMatrixPasses =
      initialEzValue === "18" &&
      floorValue === "18" &&
      emptyBarGuidance === 1 &&
      firstValue === "20.5" &&
      firstGuidance === 1 &&
      secondValue === "23" &&
      secondGuidance === 1 &&
      thirdValue === "25.5" &&
      thirdGuidance === 1;
    await record({
      number: 15,
      classification: ezMatrixPasses ? "pass" : "reproduced",
      severity: ezMatrixPasses ? "none" : "high",
      action: "Open EZ-Bar Curl at 18 lb, try to decrease below the empty bar, then advance through the first three achievable plate totals.",
      expected: "The empty bar remains 18 lb; 20.5, 23, and 25.5 lb show 1.25, 2.5, and 2.5 + 1.25 lb per side respectively.",
      observed: `Initial load ${initialEzValue}; floor ${floorValue} with empty-bar guidance ${emptyBarGuidance}; first ${firstValue} with 1.25-per-side guidance ${firstGuidance}; second ${secondValue} with 2.5-per-side guidance ${secondGuidance}; third ${thirdValue} with 2.5 + 1.25-per-side guidance ${thirdGuidance}.`,
      additionalArtifacts: [
        {
          label: "EZ-Bar Curl before increment (18 lb)",
          kind: "screenshot",
          path: ezBeforeScreenshot,
        },
        {
          label: "EZ-Bar Curl first increment (20.5 lb)",
          kind: "screenshot",
          path: ezFirstScreenshot,
        },
        {
          label: "EZ-Bar Curl second increment (23 lb)",
          kind: "screenshot",
          path: ezSecondScreenshot,
        },
      ],
    });

    await page.goto("/today");
    const activeDecision = page.getByTestId("today-decision");
    await expect(activeDecision).toContainText("Day B — Hinge and recovery");
    const discardDayB = activeDecision.getByRole("button", {
      name: "Discard this workout",
      exact: true,
    });
    await waitForHydratedReactHandler(discardDayB);
    await discardDayB.click();
    const discardDialog = page.getByRole("dialog", {
      name: "Discard Day B — Hinge and recovery?",
    });
    await expect(discardDialog).toContainText(
      "this active workout cannot be resumed afterward",
    );
    await waitForStableElement(discardDialog);
    await discardDialog
      .getByRole("button", { name: "Keep workout", exact: true })
      .click();
    const discardClosedAfterKeep = await discardDialog
      .waitFor({ state: "hidden", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const cancelPreservedDayB = await activeDecision
      .getByText("Day B — Hinge and recovery", { exact: true })
      .isVisible();
    if (discardClosedAfterKeep) await discardDayB.click();
    const confirmationReopened = discardClosedAfterKeep
      ? await discardDialog
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    if (confirmationReopened) await waitForStableElement(discardDialog);
    await settleEvidenceFrame();
    await record({
      number: 2,
      classification:
        discardClosedAfterKeep && cancelPreservedDayB && confirmationReopened
          ? "pass"
          : "reproduced",
      severity:
        discardClosedAfterKeep && cancelPreservedDayB && confirmationReopened
          ? "none"
          : "high",
      action: "Leave an unexpected Day B workout, cancel its discard once, then reopen the discard confirmation.",
      expected: "Today names the active workout, Keep workout preserves it, and a second explicit confirmation is required before discarding it.",
      observed: `Today named Day B and exposed Discard this workout. Keep workout closed the dialog: ${discardClosedAfterKeep}; preserved Day B: ${cancelPreservedDayB}; consequence-specific confirmation reopened: ${confirmationReopened}.`,
    });
    const confirmDayB = discardDialog.getByRole("button", {
      name: "Confirm discard",
      exact: true,
    });
    await expect(confirmDayB).toBeVisible();
    await waitForHydratedReactHandler(confirmDayB);
    await confirmDayB.click();
    await expect(
      page.getByRole("button", { name: "Train as planned", exact: true }),
    ).toBeVisible();

    const startDayA = page.getByRole("button", {
      name: "Train as planned",
      exact: true,
    });
    await waitForHydratedServerAction(startDayA);
    await startDayA.click();
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: BA_WORKOUT_FIXTURE.program.days[0].name,
        exact: true,
      }),
    ).toBeVisible();

    const dayAWarmup = page.locator("#workout-warmup");
    if (await dayAWarmup.isVisible()) await dayAWarmup.scrollIntoViewIfNeeded();
    await settleEvidenceFrame();
    const warmupVisible = await dayAWarmup.isVisible();
    const warmupHasExpectedText =
      warmupVisible &&
      (await dayAWarmup.innerText()).includes(
        BA_WORKOUT_FIXTURE.program.days[0].warmupNotes,
      );
    const warmupUnobscured = warmupVisible
      ? await page.evaluate(() => {
          const warmup = document.querySelector<HTMLElement>("#workout-warmup");
          const dock = document.querySelector<HTMLElement>('[aria-label="Workout status"]');
          if (!warmup) return false;
          const warmupBox = warmup.getBoundingClientRect();
          const dockBox = dock?.getBoundingClientRect();
          const intersectsDock = Boolean(
            dockBox &&
              warmupBox.left < dockBox.right &&
              warmupBox.right > dockBox.left &&
              warmupBox.top < dockBox.bottom &&
              warmupBox.bottom > dockBox.top,
          );
          const intersectsViewport =
            warmupBox.bottom > 0 &&
            warmupBox.top < innerHeight &&
            warmupBox.right > 0 &&
            warmupBox.left < innerWidth;
          return intersectsViewport && !intersectsDock;
        })
      : false;
    const warmupPasses = warmupHasExpectedText && warmupUnobscured;
    await record({
      number: 1,
      classification: warmupPasses ? "pass" : "reproduced",
      severity: warmupPasses ? "none" : "high",
      action: "Inspect the untouched Day A workout before logging a working set.",
      expected: "Complete day warm-up guidance is visible before the first working set.",
      observed: `Warm-up surface visible: ${warmupVisible}; exact saved guidance present: ${warmupHasExpectedText}; intersects the viewport without intersecting the fixed Next-set dock: ${warmupUnobscured}.`,
      followUp:
        "Checkable warm-up occurrences remain separate DATA-01 work; this result classifies only the prior visibility finding.",
    });

    const longExerciseName = "Dumbbell Lateral Raise";
    await selectExercise(longExerciseName);
    const noHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    const longExerciseHeading = dock.getByRole("heading", {
      name: longExerciseName,
      exact: true,
    });
    const completeExerciseNameVisible = await longExerciseHeading.isVisible();
    const exerciseNameUnclipped = completeExerciseNameVisible
      ? await longExerciseHeading.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            element.scrollWidth <= element.clientWidth + 1 &&
            style.textOverflow !== "ellipsis"
          );
        })
      : false;
    await longExerciseHeading.scrollIntoViewIfNeeded();
    await settleEvidenceFrame();
    const longNamePasses =
      noHorizontalOverflow &&
      completeExerciseNameVisible &&
      exerciseNameUnclipped;
    await record({
      number: 7,
      classification: longNamePasses ? "pass" : "reproduced",
      severity: longNamePasses ? "none" : "high",
      action: `Select ${longExerciseName} as the active set at the calibrated mobile width and inspect its full dock heading.`,
      expected: "The active exercise name remains readable without ellipsis, clipping, or document-level horizontal overflow.",
      observed: `Complete active exercise identity visible: ${completeExerciseNameVisible}; heading is not clipped or ellipsized: ${exerciseNameUnclipped}; no document-level overflow: ${noHorizontalOverflow}.`,
    });

    const dayAHeading = page.getByRole("heading", {
      level: 1,
      name: BA_WORKOUT_FIXTURE.program.days[0].name,
      exact: true,
    });

    const setProgressVisible = await visibleCount(page.getByText(/\d+\/\d+ sets/));
    const exerciseProgressVisible = await visibleCount(
      page.getByText(/Exercise \d+ of \d+/i),
    );
    const upcomingMovementVisible = await visibleCount(
      page.getByText(/(?:Next|Upcoming) (?:exercise|movement)/i),
    );
    await dayAHeading.scrollIntoViewIfNeeded();
    await settleEvidenceFrame();
    const completeProgressContext =
      setProgressVisible > 0 &&
      exerciseProgressVisible > 0 &&
      upcomingMovementVisible > 0;
    await record({
      number: 10,
      classification: completeProgressContext ? "pass" : "reproduced",
      severity: completeProgressContext ? "none" : "medium",
      action: "Inspect overall progress and upcoming context at the start of Day A.",
      expected: "The active screen explains total progress and the next exercise or movement.",
      observed: `Visible set-count progress surfaces: ${setProgressVisible}; visible exercise-count surfaces: ${exerciseProgressVisible}; visible upcoming-movement surfaces: ${upcomingMovementVisible}. Complete progress/upcoming context: ${completeProgressContext}.`,
    });

    const supersetBadges = page.getByText("SS", { exact: true });
    const supersetBadgeCount = await visibleCount(supersetBadges);
    if (supersetBadgeCount > 0) await supersetBadges.first().scrollIntoViewIfNeeded();
    const roundContextCount = await visibleCount(page.getByText(/Round \d+/i));
    const nextInPairCount = await visibleCount(
      page.getByText(/(?:Next|Switch) superset exercise/i),
    );
    await settleEvidenceFrame();
    await record({
      number: 11,
      classification:
        supersetBadgeCount >= 2 && roundContextCount > 0 && nextInPairCount > 0
          ? "pass"
          : "reproduced",
      severity: "high",
      action: "Inspect the paired Day A exercise cards before reaching their rounds.",
      expected: "The pair, round, active movement, next movement, and rest point are understandable.",
      observed: `${supersetBadgeCount} SS badges are present, with ${roundContextCount} round-context and ${nextInPairCount} next-in-pair surfaces in this state. The badges alone do not explain execution.`,
    });

    const activeDock = page.locator('section[id^="exercise-"]').filter({
      has: page.getByRole("button", { name: "Log set", exact: true }),
    });
    const actionVisibility = [
      { name: "Warm-up", visible: await dayAWarmup.isVisible() },
      { name: "Ask Coach", visible: await activeDock.getByRole("button", { name: "Ask Coach", exact: true }).isVisible() },
      { name: "Form guide", visible: await activeDock.getByRole("button", { name: "Form guide", exact: true }).isVisible() },
      { name: "Direct workout actions", visible: await activeDock.getByRole("button", { name: "Add note", exact: true }).isVisible() && await activeDock.getByRole("button", { name: "Pain / no issue", exact: true }).isVisible() && await activeDock.getByRole("button", { name: "Skip exercise", exact: true }).isVisible() },
      { name: "Finish", visible: await page.getByRole("complementary", { name: "Workout status" }).getByRole("button", { name: "Finish", exact: true }).isVisible() },
    ];
    const formGuideButton = activeDock.getByRole("button", {
      name: "Form guide",
      exact: true,
    });
    if (await formGuideButton.isVisible()) await formGuideButton.click();
    const formGuide = page.getByRole("dialog", { name: /form guide/i });
    const formGuideVisible = await formGuide
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (formGuideVisible) await waitForStableElement(formGuide);
    const formGuideContentCount = formGuideVisible
      ? await visibleCount(
          formGuide.getByText(
            /Reference media|General demonstration only|fully usable/i,
          ),
        )
      : 0;
    await settleEvidenceFrame();
    const allActionsAndGuidanceReachable =
      actionVisibility.every((action) => action.visible) &&
      formGuideVisible &&
      formGuideContentCount > 0;
    await record({
      number: 6,
      classification: allActionsAndGuidanceReachable ? "pass" : "reproduced",
      severity: allActionsAndGuidanceReachable ? "none" : "high",
      action: "Inspect the active card and status bar, then open the exercise form guide.",
      expected: "Warm-up, completed work, Coach, guidance, adjustment, and Finish remain reachable.",
      observed: `${actionVisibility
        .map((action) => `${action.name}: ${action.visible ? "visible" : "missing"}`)
        .join("; ")}; Form guide dialog visible: ${formGuideVisible}; visible guide content surfaces: ${formGuideContentCount}.`,
    });
    if (formGuideVisible) {
      await page.keyboard.press("Escape");
      await expect(formGuide).toHaveCount(0);
    }

    const perSetSkipCount = await visibleCount(
      activeDock.getByRole("button", { name: /skip (?:this )?set/i }),
    );
    await record({
      number: 13,
      classification: perSetSkipCount > 0 ? "changed" : "reproduced",
      severity: "high",
      action: "Inspect the active set controls for a per-set skip action and optional reason.",
      expected: "One set can be recorded as skipped with an optional durable reason.",
      observed: `${perSetSkipCount} per-set skip controls exist. Exercise-level Skip and End rest are different actions.`,
    });

    const substitutionPlannedExercise = "Barbell Back Squat";
    await selectExercise(substitutionPlannedExercise);
    const directSwapButton = activeDock.getByRole("button", {
      name: "View alternatives",
      exact: true,
    });
    const directSwapVisible = await directSwapButton.isVisible();
    if (directSwapVisible) await directSwapButton.click();
    const alternativesDialog = page.getByRole("dialog", {
      name: "Use an alternative for this workout",
    });
    const alternativesDialogVisible = directSwapVisible
      ? await alternativesDialog
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    let substitutionPerformedExercise = "";
    let substitutionApplied = false;
    if (alternativesDialogVisible) {
      await waitForStableElement(alternativesDialog);
      await alternativesDialog
        .getByRole("button", { name: "Discomfort", exact: true })
        .click();
      await alternativesDialog
        .getByRole("button", { name: "Browse alternatives", exact: true })
        .click();
      const picker = page.getByRole("dialog").last();
      if ((await picker.getByRole("button", { name: /View details for/ }).count()) === 0) {
        const families = picker.getByRole("button", { name: /\d+ variants?$/ });
        if ((await families.count()) > 0) {
          await families.nth(Math.min(1, (await families.count()) - 1)).click();
        }
      }
      const candidates = picker.getByRole("button", {
        name: /View details for/,
      });
      let candidate: Locator | null = null;
      for (let index = 0; index < (await candidates.count()); index += 1) {
        const option = candidates.nth(index);
        const optionName =
          (await option.getAttribute("aria-label"))
            ?.replace(/^View details for /, "")
            .trim() ?? "";
        if (optionName && optionName !== longExerciseName) {
          candidate = option;
          substitutionPerformedExercise = optionName;
          break;
        }
      }
      if (candidate) {
        await candidate.click();
        const useAlternative = picker.getByRole("button", {
          name: "Use for this workout",
          exact: true,
        });
        if (substitutionPerformedExercise && (await useAlternative.isVisible())) {
          await useAlternative.click();
          substitutionApplied = await activeDock
            .getByRole("heading", {
              name: substitutionPerformedExercise,
              exact: true,
            })
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
        }
      }
      if (!substitutionApplied) {
        if (await picker.isVisible()) await page.keyboard.press("Escape");
        if (await alternativesDialog.isVisible()) await page.keyboard.press("Escape");
      }
    }
    await selectExercise(longExerciseName);

    const logSet = activeDock.getByRole("button", {
      name: "Log set",
      exact: true,
    });
    const setNoteValue = "QA-04 set note stays with set one.";
    const primarySetNote = activeDock.getByPlaceholder("Set note…");
    await expect(primarySetNote).toBeVisible();
    await primarySetNote.fill(setNoteValue);
    await expect(primarySetNote).toHaveValue(setNoteValue);
    const primaryNoteScreenshot = testInfo.outputPath(
      "QA-04-OBS-09-primary-note.png",
    );
    await page.screenshot({ path: primaryNoteScreenshot });
    const logSetVisible = await logSet.isVisible();
    if (logSetVisible) await logSet.click();
    const statusBar = page.getByRole("complementary", { name: "Workout status" });
    const setSavedStatus = page
      .getByTestId("current-exercise-card")
      .locator('[data-set-row-state="saved"]');
    const setSavedStatusVisible = logSetVisible
      ? await setSavedStatus
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    const restTimer = statusBar.getByLabel("Rest timer");
    const restTimerVisible = logSetVisible
      ? await restTimer
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    const timerBox = restTimerVisible ? await restTimer.boundingBox() : null;
    const timerCount = await visibleCount(restTimer);
    const subtractTimerCount = await visibleCount(
      statusBar.getByRole("button", { name: "Decrease rest by 15 seconds", exact: true }),
    );
    const addTimerCount = await visibleCount(
      statusBar.getByRole("button", { name: "Increase rest by 15 seconds", exact: true }),
    );
    const endRestCount = await visibleCount(
      statusBar.getByRole("button", { name: "End rest", exact: true }),
    );
    const timerPresentationPasses =
      logSetVisible &&
      setSavedStatusVisible &&
      Boolean(timerBox && timerBox.height >= 44) &&
      timerCount === 1 &&
      subtractTimerCount === 1 &&
      addTimerCount === 1 &&
      endRestCount === 1;
    await record({
      number: 3,
      classification: timerPresentationPasses ? "pass" : "reproduced",
      severity: timerPresentationPasses ? "none" : "medium",
      action: "Save the first Day A set and inspect the active rest state.",
      expected: "A prominent, high-contrast timer appears once with direct adjustment controls.",
      observed: `Log set visible: ${logSetVisible}; saved/rest status visible: ${setSavedStatusVisible}; visible rest timers: ${timerCount}; height: ${Math.round(timerBox?.height ?? 0)}px; visible −15s controls: ${subtractTimerCount}; +15s controls: ${addTimerCount}; End rest controls: ${endRestCount}. The neutral timer treatment is visually captured; this checkpoint does not claim a computed contrast ratio.`,
    });
    if (!restTimerVisible) {
      throw new Error(
        "Cannot continue rest-dependent observations after QA-04-OBS-03 recorded a missing rest timer.",
      );
    }

    const savedSet = page
      .locator('[id^="exercise-"]')
      .filter({
        has: page.getByRole("heading", {
          name: longExerciseName,
          exact: true,
        }),
      })
      .first()
      .getByRole("button", { name: /Set 1/ });
    await savedSet.scrollIntoViewIfNeeded();
    const savedSetVisible = await savedSet
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const savedSetClear = savedSetVisible
      ? await expect
          .poll(async () => {
            const [setBox, dockBox] = await Promise.all([
              savedSet.boundingBox(),
              statusBar.boundingBox(),
            ]);
            return Boolean(
              setBox && dockBox && setBox.y + setBox.height <= dockBox.y,
            );
          })
          .toBe(true)
          .then(() => true)
          .catch(() => false)
      : false;
    await record({
      number: 4,
      classification: savedSetClear ? "pass" : "reproduced",
      severity: savedSetClear ? "none" : "high",
      action: "Reveal the saved set while the rest state and fixed Next-set dock remain active.",
      expected: "Completed-set history remains readable and is not covered by the active controls.",
      observed: `Saved Set 1 visible through Completed sets: ${savedSetVisible}; its lower edge remained above the fixed dock: ${savedSetClear}.`,
    });

    await expect(statusBar.getByLabel("Rest timer")).toBeVisible();
    const equipmentPreparationCount = await visibleCount(
      page.getByRole("region", { name: "Workout progress and upcoming work" }).getByText(
        /(?:prepare|set up) (?:the )?(?:next|upcoming)|next equipment/i,
      ),
    );
    await settleEvidenceFrame();
    await record({
      number: 12,
      classification: equipmentPreparationCount > 0 ? "changed" : "reproduced",
      severity: "medium",
      action: "Inspect the active rest state for next-exercise equipment preparation guidance.",
      expected: "Rest explains any useful next-equipment setup without prompting work before rest ends.",
      observed: `${equipmentPreparationCount} specific next-equipment preparation cues are present.`,
    });

    const subtract = statusBar
      .getByRole("button", {
        name: "Decrease rest by 15 seconds",
        exact: true,
      })
      .first();
    await statusBar.evaluate((dockElement) => {
      const tracked = dockElement as HTMLElement & {
        __qaReadyRestObserver?: MutationObserver;
      };
      tracked.dataset.qaReadyRestOverlap = "false";
      const inspect = () => {
        const timer = tracked.querySelector('[aria-label="Rest timer"]');
        const ready = Array.from(tracked.querySelectorAll('[role="status"]')).some(
          (status) => /next set ready/i.test(status.textContent ?? ""),
        );
        if (timer && ready) tracked.dataset.qaReadyRestOverlap = "true";
      };
      tracked.__qaReadyRestObserver = new MutationObserver(inspect);
      tracked.__qaReadyRestObserver.observe(tracked, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      inspect();
    });
    for (let index = 0; index < 20; index += 1) {
      const timer = statusBar.getByLabel("Rest timer");
      if (!(await timer.isVisible())) break;
      const timerText = await timer.innerText();
      const match = /(\d+):(\d{2})/.exec(timerText);
      const remaining = match
        ? Number(match[1]) * 60 + Number(match[2])
        : Number.POSITIVE_INFINITY;
      if (remaining <= 15) break;
      if (!(await subtract.isVisible())) break;
      await subtract.click();
    }
    const timerBeforeZero = await statusBar.getByLabel("Rest timer").isVisible();
    const readyBeforeZero =
      (await visibleCount(statusBar.getByText(/Ready/i))) > 0;
    const beforeZeroScreenshot = testInfo.outputPath(
      "QA-04-OBS-08-before-zero.png",
    );
    await resetHorizontalScroll();
    await page.screenshot({ path: beforeZeroScreenshot });
    if (timerBeforeZero && (await subtract.isVisible())) await subtract.click();
    const timerFinished = await statusBar
      .getByLabel("Rest timer")
      .waitFor({ state: "detached", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const readyAfterZero = await statusBar
      .getByText(/Ready/i)
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const readyWhileTimerActive = await statusBar.evaluate((dockElement) => {
      const tracked = dockElement as HTMLElement & {
        __qaReadyRestObserver?: MutationObserver;
      };
      tracked.__qaReadyRestObserver?.disconnect();
      return tracked.dataset.qaReadyRestOverlap === "true";
    });
    const timerTransitionPasses =
      timerBeforeZero &&
      !readyBeforeZero &&
      timerFinished &&
      readyAfterZero &&
      !readyWhileTimerActive;
    await settleEvidenceFrame();
    await record({
      number: 8,
      classification: timerTransitionPasses ? "pass" : "reproduced",
      severity: timerTransitionPasses ? "none" : "medium",
      action: "Reduce the public rest timer to zero and inspect the completed state.",
      expected: "Ready never conflicts with active rest and becomes prominent only after the timer completes.",
      observed: `Before zero, timer visible: ${timerBeforeZero} and ready visible: ${readyBeforeZero}. After zero, timer removed: ${timerFinished} and ready visible: ${readyAfterZero}. Mutation observer detected a timer/ready overlap: ${readyWhileTimerActive}.`,
      additionalArtifacts: [
        {
          label: "Rest state immediately before zero",
          kind: "screenshot",
          path: beforeZeroScreenshot,
        },
      ],
    });

    const primarySetNoteCount = await visibleCount(
      activeDock.getByPlaceholder("Set note…"),
    );
    const exerciseNoteValue = "QA-04 exercise note stays with this exercise.";
    await activeDock
      .getByRole("button", { name: "Add note", exact: true })
      .click();
    const noteAdjustDialog = page.getByRole("dialog", { name: /^Add note for / });
    await expect(noteAdjustDialog).toBeVisible();
    const exerciseNote = noteAdjustDialog.getByLabel("Exercise note", {
      exact: true,
    });
    await expect(exerciseNote).toBeVisible();
    await exerciseNote.fill(exerciseNoteValue);
    await noteAdjustDialog
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await expect(noteAdjustDialog).toHaveCount(0);

    await savedSet.click();
    const activeExerciseCard = page
      .locator('[id^="exercise-"]')
      .filter({
        has: page.getByRole("heading", {
          name: longExerciseName,
          exact: true,
        }),
      })
      .first();
    const correctionSetNote = activeExerciseCard.getByPlaceholder("Set note…");
    await expect(correctionSetNote).toBeVisible();
    const correctionSetNoteCount = await visibleCount(correctionSetNote);
    await expect(correctionSetNote).toHaveValue(setNoteValue);
    const setNotePersisted = (await correctionSetNote.inputValue()) === setNoteValue;

    const editedSetOneNote = "QA-04 edited note belongs only to set one.";
    await correctionSetNote.fill(editedSetOneNote);
    await activeExerciseCard
      .getByRole("button", { name: "Update", exact: true })
      .click();
    await expect(correctionSetNote).toHaveCount(0);
    await expect(primarySetNote).toHaveValue("");

    await activeDock
      .getByRole("button", { name: "Add note", exact: true })
      .click();
    const verifyNoteDialog = page.getByRole("dialog", { name: /^Add note for / });
    await expect(verifyNoteDialog).toBeVisible();
    const verifiedExerciseNote = verifyNoteDialog.getByLabel("Exercise note", {
      exact: true,
    });
    await expect(verifiedExerciseNote).toHaveValue(exerciseNoteValue);
    const exerciseNotePersisted =
      (await verifiedExerciseNote.inputValue()) === exerciseNoteValue;
    await page.keyboard.press("Escape");
    await expect(verifyNoteDialog).toBeHidden();

    await selectExercise(longExerciseName);
    await expect(primarySetNote).toHaveValue("");
    await primarySetNote.fill("QA-04 temporary Set 2 note to clear.");
    await primarySetNote.fill("");
    await expect(primarySetNote).toHaveValue("");
    await waitForHydratedReactHandler(logSet);
    await logSet.click();
    await expect(page.getByText("2/2 sets", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Open sets waiting to save/ }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: BA_WORKOUT_FIXTURE.program.days[0].name,
        exact: true,
      }),
    ).toBeVisible();
    const reloadedExerciseCard = page
      .locator('[id^="exercise-"]')
      .filter({
        has: page.getByRole("heading", {
          name: longExerciseName,
          exact: true,
        }),
      })
      .first();
    let setTwoButton = reloadedExerciseCard
      .locator("button")
      .filter({ hasText: "Set 2" })
      .first();
    if (!(await setTwoButton.isVisible())) {
      await reloadedExerciseCard.locator(":scope > button").click();
      setTwoButton = reloadedExerciseCard
        .locator("button")
        .filter({ hasText: "Set 2" })
        .first();
    }
    await expect(setTwoButton).toBeVisible();
    await setTwoButton.click();
    const reloadedCorrectionNote =
      reloadedExerciseCard.getByPlaceholder("Set note…");
    await expect(reloadedCorrectionNote).toHaveValue("");
    const noteScopesStayIndependent =
      exerciseNotePersisted &&
      setNotePersisted &&
      (await reloadedCorrectionNote.inputValue()) !== exerciseNoteValue;
    const setTwoStayedEmpty = (await reloadedCorrectionNote.inputValue()) === "";
    await reloadedExerciseCard
      .getByRole("button", { name: "Cancel", exact: true })
      .click();

    const finishWorkout = page.getByRole("button", {
      name: /^(?:Finish early|Finish workout)$/i,
    });
    await finishWorkout.scrollIntoViewIfNeeded();
    await waitForHydratedReactHandler(finishWorkout);
    await finishWorkout.click();
    const saveWorkout = page.getByRole("button", {
      name: /^(?:Finish early|Save workout)$/,
    });
    await expect(saveWorkout).toBeEnabled();
    await saveWorkout.click();
    await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);

    const historyExercise = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", {
          name: longExerciseName,
          exact: true,
        }),
      })
      .first();
    const setOneHistory = historyExercise
      .locator("li")
      .filter({ hasText: "Set 1" })
      .first();
    const setTwoHistory = historyExercise
      .locator("li")
      .filter({ hasText: "Set 2" })
      .first();
    await expect(setOneHistory).toContainText(editedSetOneNote);
    await expect(setTwoHistory).not.toContainText(editedSetOneNote);
    await expect(setTwoHistory).not.toContainText(setNoteValue);
    const historyAttachmentIsExact =
      (await setOneHistory.getByText(editedSetOneNote, { exact: true }).count()) === 1 &&
      !(await setTwoHistory.innerText()).includes(editedSetOneNote) &&
      !(await setTwoHistory.innerText()).includes(setNoteValue);
    const substitutionLineage = substitutionApplied
      ? page.getByText(
          `Performed ${substitutionPerformedExercise} instead of ${substitutionPlannedExercise}.`,
          { exact: false },
        )
      : page.getByText("Substitution was not applied", { exact: true });
    const substitutionLineageVisible = substitutionApplied
      ? await substitutionLineage
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    const substitutionReasonVisible = substitutionApplied
      ? await page
          .getByText(/alternative · discomfort/i)
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    const substitutionHistoryPasses =
      directSwapVisible &&
      alternativesDialogVisible &&
      substitutionApplied &&
      substitutionLineageVisible &&
      substitutionReasonVisible;
    if (substitutionLineageVisible) {
      await substitutionLineage.scrollIntoViewIfNeeded();
      await settleEvidenceFrame();
    }
    await record({
      number: 14,
      classification: substitutionHistoryPasses ? "pass" : "reproduced",
      severity: substitutionHistoryPasses ? "none" : "high",
      action: `Use the direct Swap exercise control to replace ${substitutionPlannedExercise} for discomfort, finish the workout, and inspect History.`,
      expected: "A safe one-workout substitution is directly discoverable and History names the planned exercise, performed exercise, and reason.",
      observed: `Direct Swap exercise visible: ${directSwapVisible}; alternatives dialog visible: ${alternativesDialogVisible}; substitution applied: ${substitutionApplied}; performed exercise: ${substitutionPerformedExercise || "not available"}; planned/performed History lineage visible: ${substitutionLineageVisible}; discomfort reason visible: ${substitutionReasonVisible}.`,
    });
    await setOneHistory.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await page.waitForTimeout(100);
    await page
      .locator("[data-sonner-toast]")
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(() => undefined);
    await record({
      number: 9,
      classification:
        primarySetNoteCount > 0 &&
        noteScopesStayIndependent &&
        setTwoStayedEmpty &&
        historyAttachmentIsExact
          ? "pass"
          : "reproduced",
      severity:
        primarySetNoteCount > 0 &&
        noteScopesStayIndependent &&
        setTwoStayedEmpty &&
        historyAttachmentIsExact
          ? "none"
          : "high",
      action: "Enter a note before saving Set 1, edit it by tapping the acknowledged set, immediately log a blank Set 2, finish, and inspect History.",
      expected: "Set and exercise notes are obvious before save, remain independent, and never carry forward unexpectedly.",
      observed: `Visible primary Next-set note inputs: ${primarySetNoteCount}; visible correction note inputs: ${correctionSetNoteCount}; saved Set 1 note persisted before editing: ${setNotePersisted}; saved exercise note persisted: ${exerciseNotePersisted}; the two values remained independent: ${noteScopesStayIndependent}; Set 2 stayed explicitly empty: ${setTwoStayedEmpty}; History attached the edited note only to Set 1: ${historyAttachmentIsExact}. Bodyweight wording was not exercised in this occurrence.`,
      additionalArtifacts: [
        {
          label: "Primary note entered before logging",
          kind: "screenshot",
          path: primaryNoteScreenshot,
        },
      ],
    });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await discardActiveWorkout(page).catch(() => undefined);
  }
});
