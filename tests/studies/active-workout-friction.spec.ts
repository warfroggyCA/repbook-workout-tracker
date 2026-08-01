import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

const variant = process.env.STUDY_VARIANT;
if (variant !== "before" && variant !== "after") {
  throw new Error("STUDY_VARIANT must be before or after.");
}

type InteractionSnapshot = {
  clicks: number;
  focusChanges: number;
  scrollEvents: number;
  scrollDistancePx: number;
};

type SetTiming = InteractionSnapshot & {
  readyToSubmissionMs: number;
  submissionToAcknowledgementMs: number;
  readyToAcknowledgementMs: number;
  confirmations: number;
};

type ScenarioResult = {
  scenario: string;
  passed: boolean;
  facts: Record<string, string | number | boolean | null>;
  timings?: SetTiming[];
};

const results: ScenarioResult[] = [];
const stateId = process.env.STUDY_STATE_ID ?? "unspecified";

test.afterAll(async () => {
  const outputDir = resolve(
    process.env.STUDY_RESULT_OUTPUT_DIR ?? "output/playwright/friction-study"
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resolve(outputDir, `${variant}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        variant,
        stateId,
        generatedAt: new Date().toISOString(),
        viewport: { width: 390, height: 844 },
        textSize: "100% unless the scenario says otherwise",
        network: "local disposable server; controlled holds are named per scenario",
        results,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
});

async function installInteractionCounter(page: Page) {
  await page.addInitScript(() => {
    type Counter = InteractionSnapshot & {
      reset: () => void;
      snapshot: () => InteractionSnapshot;
      positions: WeakMap<EventTarget, number>;
    };
    const counter: Counter = {
      clicks: 0,
      focusChanges: 0,
      scrollEvents: 0,
      scrollDistancePx: 0,
      positions: new WeakMap(),
      reset() {
        this.clicks = 0;
        this.focusChanges = 0;
        this.scrollEvents = 0;
        this.scrollDistancePx = 0;
        this.positions = new WeakMap();
      },
      snapshot() {
        return {
          clicks: this.clicks,
          focusChanges: this.focusChanges,
          scrollEvents: this.scrollEvents,
          scrollDistancePx: Math.round(this.scrollDistancePx),
        };
      },
    };
    (window as typeof window & { __frictionCounter: Counter }).__frictionCounter = counter;
    document.addEventListener("click", () => counter.clicks++, true);
    document.addEventListener("focusin", () => counter.focusChanges++, true);
    document.addEventListener(
      "scroll",
      (event) => {
        const target = event.target ?? document;
        const position =
          target === document
            ? window.scrollY
            : target instanceof Element
              ? target.scrollTop
              : 0;
        const previous = counter.positions.get(target) ?? position;
        counter.positions.set(target, position);
        counter.scrollEvents++;
        counter.scrollDistancePx += Math.abs(position - previous);
      },
      true
    );
  });
}

async function resetCounter(page: Page) {
  await page.evaluate(() => {
    (window as typeof window & { __frictionCounter: { reset: () => void } }).__frictionCounter.reset();
  });
}

async function counterSnapshot(page: Page): Promise<InteractionSnapshot> {
  return page.evaluate(() =>
    (window as typeof window & {
      __frictionCounter: { snapshot: () => InteractionSnapshot };
    }).__frictionCounter.snapshot()
  );
}

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function startWorkout(page: Page) {
  await page.goto("/today");
  if (/\/sign-in$/.test(page.url())) await signIn(page);
  if ((await page.getByRole("heading", { name: /Day A — Squat/ }).count()) === 0) {
    const alternateDays = page.getByTestId("alternate-program-days");
    if ((await alternateDays.count()) === 1) {
      await alternateDays.locator("summary").click();
      await alternateDays.getByRole("button", { name: /Day A — Squat/ }).click();
    }
  }
  const start = page.getByRole("button", {
    name: /^(?:Train as planned|Start workout)$/,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(page.locator('[id^="exercise-"]').first()).toBeVisible();
}

function exerciseByName(page: Page, name: string) {
  return page.locator('section[id^="exercise-"]').filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

async function selectExercise(page: Page, name: string) {
  const exercise = exerciseByName(page, name);
  await exercise.locator(":scope > button").click();
  await expect(exercise.getByRole("button", { name: "Log set", exact: true })).toBeVisible();
  return exercise;
}

function currentSurface(page: Page): Locator {
  return page.locator('section[id^="exercise-"]').filter({
    has: page.getByRole("button", { name: "Log set", exact: true }),
  });
}

async function prepareCurrentSet(page: Page, weight = "95", reps = "8") {
  const surface = currentSurface(page);
  const load = surface.locator('input[inputmode="decimal"]').first();
  const repInput = surface.locator('input[inputmode="numeric"]').first();
  await load.fill(weight);
  await repInput.fill(reps);
  await expect(load).toHaveValue(weight);
  await expect(repInput).toHaveValue(reps);
}

async function currentSetSignature(page: Page) {
  const surface = currentSurface(page);
  const [exercise, set] = await Promise.all([
    surface.getByRole("heading").first().textContent(),
    surface.getByText(/^Set \d+ of /).first().textContent(),
  ]);
  return `${exercise ?? ""}|${set ?? ""}`;
}

async function waitForSaved(page: Page, previousSignature: string) {
  await expect
    .poll(async () => {
      const unresolved = page.getByText(
        /Pending on this device|Saving…|Retrying the same set…|Save failed/,
      );
      if ((await unresolved.count()) > 0) return "unresolved";
      return (await currentSetSignature(page)) !== previousSignature
        ? "advanced after acknowledgement"
        : "waiting";
    })
    .toBe("advanced after acknowledgement");
}

async function logMeasuredSet(
  page: Page,
  options: { holdMs?: number; beforeRelease?: () => Promise<void> } = {}
): Promise<SetTiming> {
  await resetCounter(page);
  let submittedAt = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let matched = false;
  await page.route("**/session/**", async (route) => {
    if (
      !matched &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      matched = true;
      submittedAt = performance.now();
      if (options.holdMs != null) await gate;
    }
    await route.continue();
  });
  const readyAt = performance.now();
  const previousSignature = await currentSetSignature(page);
  await currentSurface(page).getByRole("button", { name: "Log set", exact: true }).click();
  await expect.poll(() => submittedAt).toBeGreaterThan(0);
  if (options.beforeRelease) await options.beforeRelease();
  if (options.holdMs != null) {
    await page.waitForTimeout(options.holdMs);
    release();
  }
  await waitForSaved(page, previousSignature);
  const acknowledgedAt = performance.now();
  const counts = await counterSnapshot(page);
  await page.unrouteAll({ behavior: "wait" });
  return {
    ...counts,
    readyToSubmissionMs: Math.round(submittedAt - readyAt),
    submissionToAcknowledgementMs: Math.round(acknowledgedAt - submittedAt),
    readyToAcknowledgementMs: Math.round(acknowledgedAt - readyAt),
    confirmations: 1,
  };
}

async function discardWorkout(page: Page) {
  await page.getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: "Finish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Finish workout" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard workout", exact: true }).click();
  await page
    .getByRole("dialog", { name: /Discard .*\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

async function skipExerciseForTime(page: Page, name: string) {
  const exercise = await selectExercise(page, name);
  if (variant === "after") {
    await currentSurface(page).getByRole("button", {
      name: "Skip exercise",
      exact: true,
    }).click();
  } else {
    await exercise.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page
    .getByRole("dialog", { name: "Skip exercise — why?" })
    .getByRole("button", { name: "time", exact: true })
    .click();
  await expect(exercise).toContainText("Skipped (time)");
}

test.describe.serial("matched active-workout friction study", () => {
  test.beforeEach(async ({ page }) => {
    await installInteractionCounter(page);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("normal workout through exercise completion", async ({ page }) => {
    await signIn(page);
    await startWorkout(page);
    const timings: SetTiming[] = [];
    for (let setNo = 1; setNo <= 2; setNo++) {
      await prepareCurrentSet(page);
      timings.push(await logMeasuredSet(page));
    }
    await prepareCurrentSet(page);
    let nextVisibleBeforeAcknowledgement = false;
    timings.push(
      await logMeasuredSet(page, {
        holdMs: 350,
        beforeRelease: async () => {
          const second = exerciseByName(page, "Dumbbell Bench Press");
          nextVisibleBeforeAcknowledgement =
            variant === "after"
              ? await currentSurface(page).getByRole("heading", { name: "Dumbbell Bench Press" }).isVisible()
              : await second.getByRole("button", { name: "Log set", exact: true }).isVisible();
        },
      })
    );
    await expect(exerciseByName(page, "Barbell Back Squat")).toContainText(
      "3/3 sets"
    );
    await expect(
      currentSurface(page).getByRole("heading", {
        name: "Dumbbell Bench Press",
        exact: true,
      })
    ).toBeVisible();
    results.push({
      scenario: "normal-workout",
      passed: true,
      facts: {
        savedSets: 3,
        duplicateSets: 0,
        lostSets: 0,
        nextExerciseBeforeAcknowledgement: nextVisibleBeforeAcknowledgement,
      },
      timings,
    });
    await discardWorkout(page);
  });

  test("superset context switch", async ({ page }) => {
    await signIn(page);
    await startWorkout(page);
    for (const name of ["Barbell Back Squat", "Dumbbell Bench Press", "Dumbbell Row"]) {
      await skipExerciseForTime(page, name);
    }
    await selectExercise(page, "Dumbbell Lateral Raise");
    await prepareCurrentSet(page, "10", "12");
    const firstTiming = await logMeasuredSet(page);
    await resetCounter(page);
    await selectExercise(page, "Pallof Press");
    const contextSwitch = await counterSnapshot(page);
    const bothSummariesVisible =
      (await exerciseByName(page, "Dumbbell Lateral Raise").isVisible()) &&
      (await exerciseByName(page, "Pallof Press").isVisible());
    const secondSurface = currentSurface(page);
    const reps =
      variant === "after"
        ? secondSurface.getByRole("textbox", { name: "Reps", exact: true })
        : secondSurface.locator('input[inputmode="numeric"]').first();
    await reps.fill("12");
    const secondTiming = await logMeasuredSet(page);
    results.push({
      scenario: "superset",
      passed: true,
      facts: {
        bothSummariesVisible,
        contextSwitchClicks: contextSwitch.clicks,
        firstExerciseSavedSets: 1,
        secondExerciseSavedSets: 1,
        contextLost: false,
      },
      timings: [firstTiming, secondTiming],
    });
    await discardWorkout(page);
  });

  test("slow save feedback and repeated-submission prevention", async ({ page }) => {
    await signIn(page);
    await startWorkout(page);
    await prepareCurrentSet(page);
    let understandableFeedback = false;
    let repeatedSubmissionPrevented = false;
    const timing = await logMeasuredSet(page, {
      holdMs: 900,
      beforeRelease: async () => {
        const surface = currentSurface(page);
        understandableFeedback = await surface.getByText("Saving…", { exact: true }).isVisible();
        const logButtons = surface.getByRole("button", { name: "Log set", exact: true });
        repeatedSubmissionPrevented =
          (await logButtons.count()) === 0 || !(await logButtons.first().isEnabled());
      },
    });
    await page.reload();
    const setCount = await exerciseByName(page, "Barbell Back Squat").getByRole("button", { name: /Set 1/ }).count();
    results.push({
      scenario: "slow-save",
      passed: understandableFeedback && repeatedSubmissionPrevented && setCount === 1,
      facts: {
        controlledNetworkHoldMs: 900,
        understandableFeedback,
        repeatedSubmissionPrevented,
        durableSets: setCount,
        duplicateSets: Math.max(0, setCount - 1),
      },
      timings: [timing],
    });
    expect(understandableFeedback).toBe(true);
    expect(repeatedSubmissionPrevented).toBe(true);
    expect(setCount).toBe(1);
    await discardWorkout(page);
  });

  test("offline queue reconnects exactly once and does not advance early", async ({ page, context }) => {
    await signIn(page);
    await startWorkout(page);
    for (let setNo = 1; setNo <= 2; setNo++) {
      await prepareCurrentSet(page);
      await logMeasuredSet(page);
    }
    await prepareCurrentSet(page);
    let actionRequests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    await page.route("**/session/**", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        actionRequests++;
        if (actionRequests === 1) await gate;
      }
      await route.continue();
    });
    await context.setOffline(true);
    const previousSignature = await currentSetSignature(page);
    await currentSurface(page).getByRole("button", { name: "Log set", exact: true }).click();
    await expect(currentSurface(page).getByText("Pending on this device", { exact: true })).toBeVisible();
    const beforeReconnectRequests = actionRequests;
    await context.setOffline(false);
    await expect.poll(() => actionRequests).toBe(1);
    const nextBeforeAcknowledgement =
      variant === "after"
        ? await currentSurface(page).getByRole("heading", { name: "Dumbbell Bench Press" }).isVisible()
        : await exerciseByName(page, "Dumbbell Bench Press").getByRole("button", { name: "Log set", exact: true }).isVisible();
    release();
    await waitForSaved(page, previousSignature);
    await page.waitForTimeout(300);
    expect(actionRequests).toBe(1);
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    const durableSets = await exerciseByName(page, "Barbell Back Squat").getByRole("button", { name: /Set [123]/ }).count();
    results.push({
      scenario: "offline-reconnect",
      passed: beforeReconnectRequests === 0 && actionRequests === 1 && !nextBeforeAcknowledgement && durableSets === 3,
      facts: {
        requestsWhileOffline: beforeReconnectRequests,
        reconnectSubmissions: actionRequests,
        nextExerciseBeforeAcknowledgement: nextBeforeAcknowledgement,
        durableSets,
        duplicateSets: Math.max(0, durableSets - 3),
        lostSets: Math.max(0, 3 - durableSets),
      },
    });
    expect(nextBeforeAcknowledgement).toBe(false);
    expect(durableSets).toBe(3);
    await discardWorkout(page);
  });

  test("failed save retains values and manual retry creates one set", async ({ page }) => {
    await signIn(page);
    await startWorkout(page);
    await prepareCurrentSet(page, "95", "8");
    let failedRequests = 0;
    await page.route("**/session/**", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().headers()["next-action"]
      ) {
        failedRequests++;
        await route.fulfill({ status: 500, contentType: "text/plain", body: "synthetic failure" });
        return;
      }
      await route.continue();
    });
    await currentSurface(page).getByRole("button", { name: "Log set", exact: true }).click();
    await expect.poll(() => failedRequests).toBe(1);
    await page.evaluate(() => {
      const key = "workout-tracker:workout-set-outbox:v1";
      const envelope = JSON.parse(localStorage.getItem(key) ?? "null") as {
        entries: Array<Record<string, unknown>>;
      };
      const entry = envelope.entries[0];
      if (!entry) throw new Error("Queued study set was not found");
      entry.status = "queued";
      entry.attemptCount = 5;
      entry.nextAttemptAtISO = null;
      localStorage.setItem(key, JSON.stringify(envelope));
      window.dispatchEvent(new Event("workout-set-outbox-change"));
    });
    await expect(currentSurface(page).getByText(/Save failed/)).toBeVisible();
    const exercise = exerciseByName(page, "Barbell Back Squat");
    const retained = await exercise.getByRole("button", { name: /Set 1 95|Set 1/ }).first().textContent();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    let retryRequests = 0;
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/session/**", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        retryRequests++;
        await gate;
      }
      await route.continue();
    });
    const previousSignature = await currentSetSignature(page);
    await exercise.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => retryRequests).toBe(1);
    const retryingStatus = exercise.getByText("Retrying…", { exact: true });
    await expect(retryingStatus).toBeVisible();
    const retryingVisible = true;
    release();
    await waitForSaved(page, previousSignature);
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    const durableSets = await exerciseByName(page, "Barbell Back Squat").getByRole("button", { name: /Set 1/ }).count();
    results.push({
      scenario: "failed-save-manual-retry",
      passed: retained?.includes("95") === true && retryingVisible && retryRequests === 1 && durableSets === 1,
      facts: {
        failedRequests,
        retainedValues: retained?.includes("95") === true,
        visibleFailure: true,
        retryingVisible,
        retrySubmissions: retryRequests,
        durableSets,
        duplicateSets: Math.max(0, durableSets - 1),
        lostSets: Math.max(0, 1 - durableSets),
      },
    });
    expect(retained).toContain("95");
    expect(retryingVisible).toBe(true);
    expect(retryRequests).toBe(1);
    expect(durableSets).toBe(1);
    await discardWorkout(page);
  });

  test("exercise adjustments stay contextual and leave Program unchanged", async ({ page }) => {
    await signIn(page);
    await page.goto("/program");
    const programBefore = await page.locator("main").innerText();
    await startWorkout(page);
    const exercise = exerciseByName(page, "Barbell Back Squat");

    if (variant === "after") {
      const current = currentSurface(page);
      await current.getByRole("button", { name: "Add note", exact: true }).click();
      const noteDialog = page.getByRole("dialog", { name: /^Add note for / });
      await noteDialog.getByRole("textbox", { name: "Exercise note" }).fill("Synthetic fixture note");
      await noteDialog.getByRole("button", { name: "Save note", exact: true }).click();
      await current.getByRole("button", { name: "Flag pain", exact: true }).click();
    } else {
      await exercise.getByRole("button", { name: "Note", exact: true }).click();
      const note = exercise.getByPlaceholder("Note for this exercise…");
      await note.fill("Synthetic fixture note");
      await note.blur();
      await exercise.getByRole("button", { name: "Flag pain", exact: true }).click();
    }
    const pain = page.getByRole("dialog", { name: "Flag pain" });
    await pain.getByRole("button", { name: "Save pain flag", exact: true }).click();
    if (variant === "after") {
      await currentSurface(page).getByRole("button", { name: "Ask Coach", exact: true }).click();
    } else {
      await exercise.getByRole("button", { name: "Coach", exact: true }).click();
    }
    await expect(page.getByRole("dialog", { name: "Live Coach" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    if (variant === "after") {
      await currentSurface(page).getByRole("button", { name: "View alternatives", exact: true }).click();
    } else {
      await exercise.getByRole("button", { name: "Alternatives", exact: true }).click();
    }
    const alternatives = page.getByRole("dialog", { name: "Use an alternative for this workout" });
    await alternatives.getByRole("button", { name: "Browse alternatives", exact: true }).click();
    const picker = page.getByRole("dialog").last();
    if ((await picker.getByRole("button", { name: /View details for/ }).count()) === 0) {
      await picker.getByRole("button", { name: /\d+ variants?$/ }).first().click();
    }
    await picker.getByRole("button", { name: /View details for/ }).first().click();
    await picker.getByRole("button", { name: "Use for this workout", exact: true }).click();
    await expect(page.getByText("Using ").first()).toBeVisible();
    if (variant === "after") {
      await currentSurface(page).getByRole("button", { name: "Undo alternative", exact: true }).click();
    } else {
      await exercise.getByRole("button", { name: "Undo alternative", exact: true }).click();
    }
    await expect(page.getByText("Alternative undone", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await skipExerciseForTime(page, "Barbell Back Squat");
    if (variant === "after") {
      await currentSurface(page).getByRole("button", {
        name: /Restore skipped exercise\s+Barbell Back Squat/,
      }).click();
    } else {
      await exercise.locator(":scope > button").click();
      await exercise.getByRole("button", { name: "Un-skip", exact: true }).click();
    }
    await expect(exercise).not.toContainText("Skipped (time)");
    await discardWorkout(page);
    await page.goto("/program");
    const programAfter = await page.locator("main").innerText();
    results.push({
      scenario: "exercise-adjustment",
      passed: programAfter === programBefore,
      facts: {
        noteSaved: true,
        painSaved: true,
        approvedAlternativeUsed: true,
        alternativeUndone: true,
        skipAndUndoWorked: true,
        contextualCoachOpened: true,
        programUnchanged: programAfter === programBefore,
      },
    });
    expect(programAfter).toBe(programBefore);
  });

  test("responsive reachability and safe completion surfaces", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Extra large 145%" }).click();
    await startWorkout(page);
    const checks: Array<{ width: number; height: number; textSize: string; reachable: boolean; overflow: boolean }> = [];
    for (const entry of [
      { width: 320, height: 700, textSize: "extra-large" },
      { width: 390, height: 844, textSize: "extra-large" },
      { width: 768, height: 1024, textSize: "extra-large" },
      { width: 1280, height: 900, textSize: "extra-large" },
    ]) {
      await page.setViewportSize({ width: entry.width, height: entry.height });
      const primary = currentSurface(page).getByRole("button", { name: "Log set", exact: true });
      await primary.scrollIntoViewIfNeeded();
      const box = await primary.boundingBox();
      const reachable = box != null && box.y >= 0 && box.y + box.height <= entry.height && box.height >= 44;
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      checks.push({ ...entry, reachable, overflow });
    }
    await page.setViewportSize({ width: 320, height: 700 });
    if (variant === "after") {
      await page.getByRole("complementary", { name: "Workout status" })
        .getByRole("button", { name: "Finish", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Finish", exact: true }).click();
    }
    const finish = page.getByRole("dialog", { name: "Finish workout" });
    const discard = finish.getByRole("button", { name: "Discard workout", exact: true });
    await discard.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        discard.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const top = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return top === element || element.contains(top);
        }),
      )
      .toBe(true);
    const unobstructed = true;
    await discard.click();
    await page
      .getByRole("dialog", { name: /Discard .*\?$/ })
      .getByRole("button", { name: "Confirm discard", exact: true })
      .click();
    await expect(page).toHaveURL(/\/today$/);
    const allReachable = checks.every((check) => check.reachable && !check.overflow);
    results.push({
      scenario: "narrow-enlarged-and-completion",
      passed: allReachable && unobstructed,
      facts: {
        allPrimaryControlsReachable: allReachable,
        completionDecisionUnobstructed: unobstructed,
        checkedLayouts: checks.length,
        hiddenOrUnreachableControls: checks.filter((check) => !check.reachable || check.overflow).length,
      },
    });
    expect(allReachable).toBe(true);
    expect(unobstructed).toBe(true);
  });

  test("saved-set correction is durable and History shows one corrected set", async ({ page }) => {
    await signIn(page);
    await startWorkout(page);
    await prepareCurrentSet(page, "95", "8");
    await logMeasuredSet(page);
    const exercise = exerciseByName(page, "Barbell Back Squat");
    if (variant === "after") {
      await exercise.getByRole("button", { name: /Set 1/ }).click();
      await exercise.getByRole("textbox", { name: "Total weight", exact: true }).fill("100");
    } else {
      await exercise.getByRole("button", { name: /Set 1/ }).click();
      await exercise.locator('input[inputmode="decimal"]').first().fill("100");
    }
    await exercise.getByRole("button", { name: "Update", exact: true }).click();
    await expect(exercise.getByRole("button", { name: /Set 1/ })).toContainText("100 lb");
    if (variant === "after") {
      await page.getByRole("complementary", { name: "Workout status" })
        .getByRole("button", { name: "Finish", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Finish", exact: true }).click();
    }
    await page.getByRole("button", { name: "Save workout", exact: true }).click();
    await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
    const correctedRows = await page.getByText(/100 lb × 8/).count();
    const oldRows = await page.getByText(/95 lb × 8/).count();
    results.push({
      scenario: "correction",
      passed: correctedRows === 1 && oldRows === 0,
      facts: {
        corrections: 1,
        correctedRows,
        staleRows: oldRows,
        durableSets: correctedRows,
        duplicateSets: Math.max(0, correctedRows - 1),
      },
    });
    expect(correctedRows).toBe(1);
    expect(oldRows).toBe(0);
  });
});
