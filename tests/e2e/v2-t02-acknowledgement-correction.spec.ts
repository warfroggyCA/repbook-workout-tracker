import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { WORKOUT_INTERACTION_MARKS } from "../../src/lib/workout-interaction-performance";

const SET_OUTBOX_KEY = "workout-tracker:workout-set-outbox:v1";

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function p95(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? Infinity;
}

async function signInAndStartWorkout(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  await alternateDays.getByRole("button", { name: /Day A — Squat/ }).click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function addWorkoutOnlyExercise(
  page: Page,
  name: string,
  initialSets = 1,
) {
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
  await review.getByLabel("Initial sets").fill(String(initialSets));
  await review.getByRole("button", { name: "Add exercise", exact: true }).click();
  await expect(page.getByRole("region", { name })).toContainText("Workout only");
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("button", { name: /^(?:Finish early|Finish workout)$/i })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("keeps retained sets responsive before acknowledgement, then reviews a correction", async ({
  page,
}) => {
  await signInAndStartWorkout(page);
  await addWorkoutOnlyExercise(page, "RKC Plank", 2);
  const sessionUrl = page.url();
  const plank = page.getByRole("region", { name: "RKC Plank" });
  await plank.getByRole("button", { name: /RKC Plank/ }).click();

  let delayNextAction = false;
  const releaseNextAction = deferred();
  const nextActionHeld = deferred();
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      delayNextAction &&
      request.method() === "POST" &&
      request.headers()["next-action"]
    ) {
      delayNextAction = false;
      nextActionHeld.resolve();
      await releaseNextAction.promise;
    }
    await route.continue();
  });

  await plank.getByLabel("Duration in seconds").fill("45");
  await page.evaluate((marks) => {
    for (const mark of marks) performance.clearMarks(mark);
  }, [
    WORKOUT_INTERACTION_MARKS.setLogTap,
    WORKOUT_INTERACTION_MARKS.setRetainedLocally,
    WORKOUT_INTERACTION_MARKS.setUiAdvanced,
    WORKOUT_INTERACTION_MARKS.setAcknowledged,
  ]);
  // Arm the delay only for the submission under test. Background server
  // actions can otherwise consume it before Log set is clicked in slower CI.
  delayNextAction = true;
  const logSetClick = plank.getByRole("button", {
    name: "Log set",
    exact: true,
  }).click();
  await nextActionHeld.promise;
  const markNames = [
    WORKOUT_INTERACTION_MARKS.setLogTap,
    WORKOUT_INTERACTION_MARKS.setRetainedLocally,
    WORKOUT_INTERACTION_MARKS.setUiAdvanced,
    WORKOUT_INTERACTION_MARKS.setAcknowledged,
  ];
  await expect.poll(() => page.evaluate((names) =>
    names.map((name) => performance.getEntriesByName(name, "mark").length),
  markNames)).toEqual([1, 1, 1, 0]);
  await expect(plank.getByRole("button", { name: "Correct set" })).toHaveCount(0);
  await expect(plank).toContainText("0/2 done · 1 saving · Workout only");
  const plankDisclosure = plank.getByRole("button", { name: /RKC Plank/ });
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "true");
  await logSetClick;

  const restStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const interSetRest = restStatus.getByRole("region", { name: "Rest timer" });
  await expect(interSetRest).toBeVisible();
  const endRest = interSetRest.getByRole("button", {
    name: "End rest",
    exact: true,
  });
  if (await endRest.isVisible()) await endRest.click();
  await expect(interSetRest).toHaveCount(0, { timeout: 5_000 });
  await expect(
    page
      .getByTestId("current-exercise-card")
      .getByRole("heading", { level: 2 }),
  ).toHaveText("Barbell Back Squat");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await plankDisclosure.click();
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "true");

  await plank.getByLabel("Duration in seconds").fill("45");
  const secondLogSetClick = plank.getByRole("button", {
    name: "Log set",
    exact: true,
  }).click();
  // This is the lock-separation proof: the first Server Action is still held,
  // but the next set must reach durable device retention and advance the UI.
  await expect.poll(() => page.evaluate((names) =>
    names.map((name) => performance.getEntriesByName(name, "mark").length),
  markNames)).toEqual([2, 2, 2, 0]);
  await expect(plank).toContainText("0/2 done · 2 saving · Workout only");
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "false");

  const delayedDurations = await page.evaluate((names) => {
    const [tapName, retainedName, advancedName] = names;
    if (!tapName || !retainedName || !advancedName) {
      throw new Error("The set interaction mark names are incomplete.");
    }
    const taps = performance.getEntriesByName(tapName, "mark");
    const retained = performance.getEntriesByName(retainedName, "mark");
    const advanced = performance.getEntriesByName(advancedName, "mark");
    return {
      retained: retained.map((entry, index) =>
        entry.startTime - taps[index]!.startTime),
      advanced: advanced.map((entry, index) =>
        entry.startTime - taps[index]!.startTime),
    };
  }, markNames.slice(0, 3));
  expect(delayedDurations.retained).toHaveLength(2);
  expect(delayedDurations.advanced).toHaveLength(2);
  expect(
    p95(delayedDurations.retained),
    `tap-to-retention durations: ${JSON.stringify(delayedDurations.retained)}`,
  ).toBeLessThan(100);
  expect(
    p95(delayedDurations.advanced),
    `tap-to-advance durations: ${JSON.stringify(delayedDurations.advanced)}`,
  ).toBeLessThan(100);

  releaseNextAction.resolve();
  await secondLogSetClick;
  await expect.poll(() => page.evaluate((name) =>
    performance.getEntriesByName(name, "mark").length,
  WORKOUT_INTERACTION_MARKS.setAcknowledged)).toBe(2);
  await expect(plank).toContainText("2/2 done · Workout only");
  const guidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  const rest = page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("region", { name: "Rest timer" });
  await expect(rest).toBeVisible();
  await expect(rest).toContainText("No further work");
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await plankDisclosure.click();
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "true");
  const exerciseDetails = plank.getByTestId("active-exercise-details");
  await openNativeDetails(exerciseDetails);
  const acknowledgement = plank.getByTestId("completed-sets");
  await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
  await expect(acknowledgement).toContainText("45 sec");
  await expect(acknowledgement).toContainText("Acknowledged by Repbook");
  await expect(
    acknowledgement.getByRole("button", { name: "Correct set" }).first(),
  ).toBeVisible();

  await acknowledgement
    .getByRole("button", { name: "Correct set" })
    .first()
    .click();
  const correction = page.getByRole("dialog", { name: "Correct acknowledged set 1" });
  await correction.getByLabel("Duration (seconds)").fill("60");
  await correction
    .getByLabel("Why are you correcting this?")
    .selectOption("measurement_entry");
  await correction.getByLabel("Reason detail").fill("Checked the stopwatch");
  await correction.getByRole("button", { name: "Review correction" }).click();
  await expect(correction).toContainText("Original");
  await expect(correction).toContainText("45 sec");
  await expect(correction).toContainText("60 sec");
  await correction
    .getByLabel(/I reviewed these values and want this correction/)
    .check();
  await correction
    .getByRole("button", { name: "Save reviewed correction" })
    .click();

  await expect(page.getByText("Set correction acknowledged")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "false");
  await waitForHydratedReactHandler(plankDisclosure);
  await plankDisclosure.click();
  await openNativeDetails(exerciseDetails);
  const correctedLedgerRow = plank
    .getByTestId("active-set-ledger")
    .locator('[data-set-row-state="saved"]')
    .first();
  await expect(correctedLedgerRow).toContainText("1:00");
  await expect(correctedLedgerRow).toContainText(
    "Latest: Corrected · 1 change",
  );
  await expect(plank).toContainText(
    "1 saved correction · original retained in Edit history",
  );

  await page.goto("/recovery/versions");
  await expect(
    page.getByText("Correction evidence", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Checked the stopwatch/).first()).toBeVisible();
  await expect(page.getByText(/Workout revision 1 → 2/).first()).toBeVisible();

  await page.goto(sessionUrl);
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 3,
        entries: [{ clientKey: crypto.randomUUID(), weight: 100, reps: 5 }],
      }),
    );
  }, SET_OUTBOX_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  const recovery = page.getByRole("button", { name: "Open sets waiting to save" });
  await expect(recovery).toBeVisible();
  await recovery.click();
  await expect(page.getByText("Sets we couldn't read", { exact: true })).toBeVisible();
  await expect(page.getByText(/older recording format/)).toBeVisible();

  await page.evaluate((key) => localStorage.removeItem(key), SET_OUTBOX_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await discardWorkout(page);
});
