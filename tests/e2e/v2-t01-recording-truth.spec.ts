import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

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

async function addWorkoutOnlyExercise(page: Page, name: string) {
  const add = page.getByRole("button", {
    name: "Add exercise to this workout",
    exact: true,
  });
  const picker = page.getByRole("dialog", {
    name: "Choose an exercise for this workout",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForHydratedReactHandler(add);
    await add.click();
    try {
      await expect(picker).toBeVisible({ timeout: 15_000 });
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      // A loaded, still-enabled trigger means WebKit missed the activation.
      // Retry once; an in-flight or failed option request remains a real failure.
      await expect(add).toBeEnabled({ timeout: 5_000 });
    }
  }

  await picker.getByRole("textbox", { name: "Search exercise library" }).fill(name);
  await picker
    .getByRole("button", { name: `View details for ${name}`, exact: true })
    .click();
  await picker
    .getByRole("button", { name: "Review exercise", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Add exercise to this workout",
  });
  await review.getByLabel("Initial sets").fill("1");
  await review.getByRole("button", { name: "Add exercise", exact: true }).click();
  await expect(page.getByRole("region", { name, exact: true })).toContainText(
    "Workout only",
  );
}

async function expectSetQueueDrained(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    return parsed.entries?.length ?? 0;
  })).toBe(0);
}

async function dismissRestCockpit(page: Page) {
  const status = page.getByRole("complementary", { name: "Workout status" });
  const rest = status.getByTestId("rest-cockpit");
  await expect(rest).toBeVisible();
  const skip = rest.getByRole("button", { name: "Skip rest", exact: true });
  if (await skip.isVisible()) await skip.click();
  const dismiss = rest.getByRole("button", {
    name: "Dismiss rest timer",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(rest).toHaveCount(0);
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("button", { name: /^(?:Finish early|Finish workout)$/i })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("records duration and distance as explicit performed measurements without invented reps or load", async ({
  page,
}) => {
  await signInAndStartWorkout(page);
  await addWorkoutOnlyExercise(page, "RKC Plank");
  await addWorkoutOnlyExercise(page, "Walking");

  const plank = page.getByRole("region", {
    name: "RKC Plank",
    exact: true,
  });
  await plank.getByRole("button", { name: /RKC Plank/ }).click();
  await expect(plank.getByRole("textbox", { name: "Reps", exact: true }))
    .toHaveCount(0);
  await expect(plank.getByRole("textbox", { name: "Weight", exact: true }))
    .toHaveCount(0);
  await plank.getByLabel("Duration in seconds").fill("45");
  await plank.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(plank).toContainText("1/1 done · Workout only");
  await expectSetQueueDrained(page);
  await dismissRestCockpit(page);

  const walking = page.getByRole("region", {
    name: "Walking",
    exact: true,
  });
  await walking.getByRole("button", { name: /Walking/ }).click();
  await expect(walking.getByRole("textbox", { name: "Reps", exact: true }))
    .toHaveCount(0);
  await expect(walking.getByRole("textbox", { name: "Weight", exact: true }))
    .toHaveCount(0);
  await walking.getByLabel("Distance in kilometres").fill("1.2");
  await walking.getByLabel("Duration in seconds").fill("600");
  await walking.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(walking).toContainText("1/1 done · Workout only");
  await expectSetQueueDrained(page);
  await dismissRestCockpit(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredPlank = page.getByRole("region", {
    name: "RKC Plank",
    exact: true,
  });
  const restoredWalking = page.getByRole("region", {
    name: "Walking",
    exact: true,
  });
  await expect(restoredPlank).toContainText("1/1 done · Workout only");
  await restoredPlank.getByRole("button", { name: /RKC Plank/ }).click();
  await restoredPlank
    .getByTestId("active-exercise-details")
    .locator(":scope > summary")
    .click();
  await expect(
    restoredPlank
      .getByTestId("active-set-ledger")
      .locator('[data-set-row-state="saved"]'),
  ).toContainText("45 sec");
  await expect(restoredWalking).toContainText("1/1 done · Workout only");
  await restoredWalking.getByRole("button", { name: /Walking/ }).click();
  await restoredWalking
    .getByTestId("active-exercise-details")
    .locator(":scope > summary")
    .click();
  await expect(
    restoredWalking
      .getByTestId("active-set-ledger")
      .locator('[data-set-row-state="saved"]'),
  ).toContainText("1.2 km · 10:00");

  await discardWorkout(page);
});
