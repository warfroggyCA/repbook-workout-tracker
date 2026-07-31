import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const evidenceDirectory = resolve(
  "output/playwright/remediation-2026-07-23-operability-stage3-r1",
);
const captureEvidence = process.env.STAGE3_CAPTURE_EVIDENCE === "1";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (captureEvidence) await mkdir(evidenceDirectory, { recursive: true });
});

async function screenshot(page: Page, name: string) {
  if (!captureEvidence) return;
  await page.screenshot({
    path: resolve(evidenceDirectory, name),
    fullPage: true,
  });
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page
    .getByPlaceholder("allowlisted email")
    .fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectSaved(page: Page) {
  await expect(page.getByRole("status")).toContainText("All changes saved");
}

function isExpectedOptimizedRequestCancellation(failure: string) {
  if (!failure.endsWith(" — net::ERR_ABORTED")) return false;
  return (
    /^POST http:\/\/[^/]+\/(?:sign-in|today|session\/[0-9a-f-]+) — /.test(failure) ||
    /^(?:GET|POST) http:\/\/[^/]+\/api\/program\/draft — /.test(failure) ||
    (/^GET http:\/\/[^/]+\//.test(failure) && failure.includes("_rsc="))
  );
}

function isExpectedFreshEditorResponse(failure: string) {
  return /^404 GET http:\/\/[^/]+\/api\/program\/draft$/.test(failure);
}

test("publishes and preserves durable warm-up and grouped workout outcomes", async ({
  page,
  context,
}) => {
  const browserErrors: string[] = [];
  const requestFailures: string[] = [];
  const httpErrors: string[] = [];
  let intentionallyOffline = false;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "failed";
    if (intentionallyOffline && errorText === "net::ERR_INTERNET_DISCONNECTED") {
      return;
    }
    requestFailures.push(`${request.method()} ${request.url()} — ${errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);
  await page.getByRole("tab", { name: /Day 2.*Hinge/ }).click();
  await expect(page.getByRole("heading", { name: "Day B — Hinge" })).toBeVisible();

  await page
    .locator("summary")
    .filter({ hasText: "Optional check-off steps" })
    .click();
  await page.getByRole("button", { name: "Add warm-up step", exact: true }).click();
  const warmupStep = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Step 1", exact: true }),
  });
  await warmupStep.getByLabel("Step", { exact: true }).fill("Activation ramp");
  await warmupStep.getByLabel("Repetitions (optional)").fill("8");
  await warmupStep.getByLabel("Loading method").selectOption("numeric");
  await warmupStep.getByLabel("Load", { exact: true }).fill("45");
  await warmupStep.getByLabel("Unit", { exact: true }).selectOption("lb");
  await warmupStep
    .getByLabel("Notes (optional)")
    .fill("Move smoothly and brace before every rep.");

  await page.getByRole("button", { name: "Group exercises", exact: true }).click();
  const groupChoices = page.getByLabel(/^Select /);
  await expect(groupChoices).toHaveCount(5);
  await groupChoices.nth(0).check();
  await groupChoices.nth(1).check();
  await groupChoices.nth(2).check();
  await page.getByRole("button", { name: "Make superset", exact: true }).click();
  const groupDetails = page
    .locator("details")
    .filter({ hasText: "3-exercise group:" })
    .first();
  await groupDetails.locator("summary").click();
  const memberRest = groupDetails.getByRole("group", {
    name: "Rest between members",
  });
  await memberRest.getByLabel("Minutes").selectOption("0");
  await memberRest.getByLabel("Seconds").selectOption("15");
  const roundRest = groupDetails.getByRole("group", {
    name: "Rest after each round",
  });
  await roundRest.getByLabel("Minutes").selectOption("0");
  await roundRest.getByLabel("Seconds").selectOption("30");
  await expectSaved(page);

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Ready to activate" })).toBeVisible();
  await page
    .getByRole("button", { name: "Activate new version", exact: true })
    .click();
  await expect(page.getByText("New Program version activated", { exact: true })).toBeVisible();

  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Day B — Hinge" })).toBeVisible();
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);

  const warmup = page.locator("#workout-warmup");
  const warmupRow = warmup.locator("li").filter({ hasText: "Activation ramp" });
  const workoutGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  const workoutStatus = page.getByRole("complementary", { name: "Workout status" });
  await expect(workoutGuidance).toContainText("Now: Activation ramp");
  await expect(workoutGuidance).toContainText(
    "Next: Romanian Deadlift, set 1",
  );
  await expect(workoutStatus).toContainText("Activation ramp");
  await expect(workoutStatus).toContainText("Warm-up");
  await expect(workoutStatus).not.toContainText("Romanian Deadlift");
  await expect(warmupRow).toContainText("8 reps · 45 lb");
  await expect(warmupRow).toContainText(
    "Plan: Move smoothly and brace before every rep.",
  );
  await screenshot(page, "01-live-warmup-prescription.png");

  intentionallyOffline = true;
  await context.setOffline(true);
  await warmupRow.getByRole("button", { name: "Add note", exact: true }).click();
  const noteDialog = page.getByRole("dialog", { name: "Note for Activation ramp" });
  await noteDialog
    .getByLabel("Workout-item note")
    .fill("Offline warm-up note survives reconnect.");
  await noteDialog.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open unsaved workout changes" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem(
          "workout-tracker:occurrence-mutation-outbox:v1",
        );
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          entries?: Array<{ operation?: string; note?: string }>;
        };
        return parsed.entries?.[0] ?? null;
      }),
    )
    .toMatchObject({
      operation: "note",
      note: "Offline warm-up note survives reconnect.",
    });
  await screenshot(page, "02-offline-warmup-note-queued.png");

  await context.setOffline(false);
  intentionallyOffline = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedWarmupRow = page
    .locator("#workout-warmup li")
    .filter({ hasText: "Activation ramp" });
  await expect(reloadedWarmupRow).toContainText(
    "Note: Offline warm-up note survives reconnect.",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          localStorage.getItem(
            "workout-tracker:occurrence-mutation-outbox:v1",
          ) ?? "",
      ),
    )
    .not.toContain("Offline warm-up note survives reconnect.");

  await reloadedWarmupRow.getByRole("button", { name: "Skip", exact: true }).click();
  const warmupSkip = page.getByRole("dialog", { name: "Skip Activation ramp?" });
  await warmupSkip.getByLabel("Reason").selectOption("fatigue");
  await warmupSkip
    .getByLabel("Optional note")
    .fill("Briefly skipped to prove recovery controls.");
  await warmupSkip.getByRole("button", { name: "Skip item", exact: true }).click();
  const completedWarmup = page.locator("details#workout-warmup");
  await expect(completedWarmup).not.toHaveAttribute("open", "");
  await completedWarmup.locator("summary").click();
  await expect(reloadedWarmupRow).toContainText("skipped");
  await expect(reloadedWarmupRow).toContainText(
    "Note: Briefly skipped to prove recovery controls.",
  );
  await reloadedWarmupRow.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(reloadedWarmupRow.getByRole("checkbox", { name: "Mark Activation ramp complete", exact: true })).toBeVisible();
  await reloadedWarmupRow.getByRole("checkbox", { name: "Mark Activation ramp complete", exact: true }).click();
  await expect(page.locator("details#workout-warmup")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator("#workout-warmup")).toContainText(
    "Warm-up complete",
  );
  await expect(workoutGuidance).toContainText(
    "Now: Romanian Deadlift, set 1",
  );
  await expect(workoutStatus).toContainText("Romanian Deadlift");
  await screenshot(page, "03-warmup-restored-and-completed.png");
  await waitForEquipmentSelectionsToSettle(page);

  const nextSet = page.getByTestId("current-exercise-card");
  await expect(nextSet.getByRole("heading", { level: 2 })).toHaveText("Romanian Deadlift");
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(nextSet.getByRole("heading", { level: 2 })).toHaveText("Barbell Overhead Press");
  await expect(workoutStatus.getByLabel("Rest timer")).toContainText(/0:1[0-5]/);
  await screenshot(page, "04-triset-next-action-and-member-rest.png");
  await workoutStatus.getByRole("button", { name: "Skip rest", exact: true }).click();
  await workoutStatus.locator("button").first().click();

  await nextSet.getByRole("button", { name: "Skip set", exact: true }).click();
  const workingSkip = page.getByRole("dialog", {
    name: "Skip set 1 of Barbell Overhead Press?",
  });
  await workingSkip.getByLabel("Reason").selectOption("pain");
  await workingSkip
    .getByLabel("Optional note")
    .fill("Shoulder discomfort during setup.");
  await workingSkip.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(nextSet.getByRole("heading", { level: 2 })).toHaveText("Band Lat Pulldown");
  await expect(page.getByRole("button", { name: "Open unsaved workout changes" })).toHaveCount(0);
  await workoutStatus.locator("button").first().click();

  await nextSet.getByRole("button", { name: "View alternatives", exact: true }).click();
  const alternatives = page.getByRole("dialog", {
    name: "Use an alternative for this workout",
  });
  await expect(alternatives).toBeVisible();
  await alternatives.getByRole("button", { name: "Discomfort", exact: true }).click();
  await alternatives
    .getByRole("button", { name: "Browse alternatives", exact: true })
    .click();
  const picker = page.getByRole("dialog").last();
  if ((await picker.getByRole("button", { name: /View details for/ }).count()) === 0) {
    const families = picker.getByRole("button", { name: /\d+ variants?$/ });
    await expect(families.first()).toBeVisible();
    await families.first().click();
  }
  const alternative = picker.getByRole("button", { name: /View details for/ }).first();
  const alternativeLabel = await alternative.getAttribute("aria-label");
  const performedExercise = alternativeLabel
    ?.replace(/^View details for /, "")
    .trim();
  if (!performedExercise) throw new Error("The group-member alternative was not named.");
  await alternative.click();
  await picker.getByRole("button", { name: "Use for this workout", exact: true }).click();
  await expect(alternatives).toHaveCount(0);
  await expect(nextSet.getByRole("heading", { level: 2 })).toHaveText(performedExercise);
  await nextSet.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(alternatives).toHaveCount(0);
  await expect(nextSet.getByRole("heading", { level: 2 })).toHaveText("Romanian Deadlift");
  await expect(workoutStatus.getByLabel("Rest timer")).toContainText(/0:(?:2[5-9]|30)/);
  await screenshot(page, "05-complete-round-and-between-round-rest.png");

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedNextSet = page.getByTestId("current-exercise-card");
  await expect(
    reloadedNextSet.getByRole("heading", { level: 2 }),
  ).toHaveText("Romanian Deadlift");
  await expect(reloadedNextSet).toContainText("Set 2 of 3");
  await screenshot(page, "06-group-round-reload-continuity.png");

  await page.getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: "Finish", exact: true }).click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await expect(finish).toContainText(/2 of \d+ planned sets done/);
  await expect(finish).toContainText(/1 skipped · \d+ still pending/);
  await expect(finish).toContainText(
    "Superset 1, round 1: 2 of 3 performed · 1 skipped",
  );
  await screenshot(page, "07-early-finish-partial-group-truth.png");
  await finish.getByRole("button", { name: "Save workout", exact: true }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);

  const outcomes = page.getByRole("heading", {
    name: "Plan and results",
  }).locator("..");
  await expect(outcomes).toContainText("Activation ramp");
  await expect(outcomes).toContainText(
    "Planned: 8 reps · 45 lb · Move smoothly and brace before every rep.",
  );
  await expect(outcomes).toContainText("Barbell Overhead Press · set 1");
  await expect(outcomes).toContainText("Reason: pain");
  await expect(outcomes).toContainText("Note: Shoulder discomfort during setup.");
  await expect(outcomes).toContainText("Group round 1 · member 2 · 15s rest after");
  await expect(outcomes).toContainText("Group round 1 · member 3 · 30s rest after");
  await expect(
    page.getByText(`Performed ${performedExercise} instead of Band Lat Pulldown.`, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText(/alternative · discomfort/i)).toBeVisible();
  await screenshot(page, "08-history-preserves-stage3-outcomes.png");

  expect(browserErrors.filter((message) => message !== "NEXT_REDIRECT")).toEqual([]);
  expect(
    requestFailures.filter(
      (failure) => !isExpectedOptimizedRequestCancellation(failure),
    ),
  ).toEqual([]);
  expect(
    httpErrors.filter((failure) => !isExpectedFreshEditorResponse(failure)),
  ).toEqual([]);
});
