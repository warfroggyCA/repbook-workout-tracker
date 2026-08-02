import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const SET_OUTBOX_KEY = "workout-tracker:workout-set-outbox:v1";

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
  await review.getByLabel("Initial sets").fill("1");
  await review.getByRole("button", { name: "Add exercise", exact: true }).click();
  await expect(page.getByRole("region", { name })).toContainText("Workout only");
}

async function discardWorkout(page: Page) {
  await page.getByRole("button", { name: "Finish Workout", exact: true }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish.getByRole("button", { name: "Discard workout", exact: true }).click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("keeps a set pending until acknowledgement, then reviews and retains a correction", async ({
  page,
}) => {
  await signInAndStartWorkout(page);
  await addWorkoutOnlyExercise(page, "RKC Plank");
  const sessionUrl = page.url();
  const plank = page.getByRole("region", { name: "RKC Plank" });
  await plank.getByRole("button", { name: /RKC Plank/ }).click();

  let delayNextAction = true;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      delayNextAction &&
      request.method() === "POST" &&
      request.headers()["next-action"]
    ) {
      delayNextAction = false;
      await new Promise((resolve) => setTimeout(resolve, 1_250));
    }
    await route.continue();
  });

  await plank.getByLabel("Duration in seconds").fill("45");
  await plank.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(plank.getByRole("status")).toContainText("Saving");
  await expect(plank.getByRole("button", { name: "Correct set" })).toHaveCount(0);
  await expect(plank).toContainText("1/1 workout-only performed");
  const plankDisclosure = plank.getByRole("button", { name: /RKC Plank/ });
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "false");
  await plankDisclosure.click();
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(plank).toContainText("Acknowledged by Repbook");
  await expect(plank.getByText("45 sec", { exact: true })).toBeVisible();
  await expect(plank.getByRole("button", { name: "Correct set" })).toBeVisible();

  await plank.getByRole("button", { name: "Correct set" }).click();
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
  await page.reload({ waitUntil: "networkidle" });
  await expect(plankDisclosure).toHaveAttribute("aria-expanded", "false");
  await waitForHydratedReactHandler(plankDisclosure);
  await plankDisclosure.click();
  await expect(plank.getByText("1:00", { exact: true })).toBeVisible();
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
