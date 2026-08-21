import { expect, test, type Page } from "@playwright/test";
import {
  waitForEquipmentSelectionsToSettle,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

const PROGRAM_TEXT = `Program: Two-day integrity plan
Day 1 — Squat
Warm-up: Easy bike | load=5 minutes
Warm-up: Hip circles | reps=10
Barbell Back Squat 3x5 @ 60 kg, rest 2 min
Ramp-up: Empty bar | reps=10
Ramp-up: Half of working load | load=50% of working load
Dumbbell Row 2x8 @ 20 kg, rest 1 min
Day 2 — Push
Warm-up: Shoulder circles | reps=10
Barbell Bench Press 3x8 @ 50 kg, rest 2 min
Ramp-up: Empty bar | reps=12
Dumbbell Reverse Lunge 2x8 @ 15 kg, rest 1 min`;

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

test("reviews and publishes a multi-day Program into an ordered active workout", async ({
  browserName,
  page,
}) => {
  const errors: string[] = [];
  const prefetches = observeNextRscPrefetches(page, browserName);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });

  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/program/import");
  const paste = page.getByLabel("Paste your Program");
  await paste.fill(PROGRAM_TEXT);
  await expect(page.getByText("0 / 20,000 characters", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Parse for review", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Review the proposed Program" })).toBeVisible();
  const easyBikeInstruction = page.getByRole("textbox", {
    name: /Squat, warm-up 1, Easy bike, instruction$/,
  });
  const firstEmptyBarInstruction = page.getByRole("textbox", {
    name: /Squat, warm-up 3, Empty bar, instruction$/,
  });
  const halfLoadInstruction = page.getByRole("textbox", {
    name: /Squat, warm-up 4, Half of working load, instruction$/,
  });
  const secondEmptyBarInstruction = page.getByRole("textbox", {
    name: /Push, warm-up 2, Empty bar, instruction$/,
  });
  await expect(easyBikeInstruction).toHaveValue("Easy bike");
  await expect(firstEmptyBarInstruction).toHaveValue("Empty bar");
  await expect(halfLoadInstruction).toHaveValue("Half of working load");
  await expect(secondEmptyBarInstruction).toHaveValue("Empty bar");
  await expect(page.getByText("Structured training intent to publish", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Repbook keeps the published exercises, order, and pairings/)).toBeVisible();
  await expect(page.getByText(/Automatic replacement: off\. Automatic omission: off\./)).toHaveCount(4);
  await expect(page.getByText(/Day plan to review:/)).toHaveCount(2);
  await expect(page.getByText(/Shorter-session choice to review:/)).toHaveCount(4);

  const easyBikeTiming = page.getByRole("combobox", {
    name: /Squat, warm-up 1, Easy bike, when it happens$/,
  });
  const hipTiming = page.getByRole("combobox", {
    name: /Squat, warm-up 2, Hip circles, when it happens$/,
  });
  const firstEmptyBarTiming = page.getByRole("combobox", {
    name: /Squat, warm-up 3, Empty bar, when it happens$/,
  });
  await expect(easyBikeTiming).toHaveValue("");
  await expect(hipTiming).toHaveValue("");
  await expect(firstEmptyBarTiming).not.toHaveValue("");

  await easyBikeInstruction.fill("Easy bike warm-up");
  const editedEasyBike = page.getByRole("textbox", {
    name: /Squat, warm-up 1, Easy bike warm-up, instruction$/,
  });
  await expect(editedEasyBike).toHaveValue("Easy bike warm-up");
  const hipIncluded = page.getByRole("checkbox", {
    name: /Squat, warm-up 2, Hip circles, include$/,
  });
  await hipIncluded.uncheck();
  await expect(hipIncluded).not.toBeChecked();
  await hipIncluded.check();
  await hipTiming.selectOption({ label: "Before Barbell Back Squat" });
  await expect(hipTiming).not.toHaveValue("");
  await hipTiming.selectOption({ label: "At the start of the workout" });
  await page.getByRole("button", {
    name: /Squat, warm-up 1, Easy bike warm-up, move later at this point$/,
  }).click();
  await page.getByRole("button", {
    name: /Squat, warm-up 2, Easy bike warm-up, move earlier at this point$/,
  }).click();
  await page.getByRole("button", { name: /Squat, add warm-up step$/ }).click();
  await page.getByRole("button", {
    name: /Squat, warm-up 3, unnamed step, remove$/,
  }).click();

  const warmupControlLabels = await page
    .locator('section[aria-labelledby^="warmups-"] :is(button,input,select,textarea)')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    );
  expect(warmupControlLabels.every((label) => Boolean(label))).toBe(true);
  expect(new Set(warmupControlLabels).size).toBe(warmupControlLabels.length);
  await expect(page.getByLabel(/Squat, Barbell Back Squat, planned sets$/)).toHaveValue("3");
  await expect(page.getByLabel(/Push, Barbell Bench Press, planned sets$/)).toHaveValue("3");

  await page.getByRole("checkbox", {
    name: /Squat: I reviewed this day’s goal, time range, exercise priorities, and minimum sets/,
  }).check();
  await page.getByRole("checkbox", {
    name: /Push: I reviewed this day’s goal, time range, exercise priorities, and minimum sets/,
  }).check();
  await page.getByRole("checkbox", {
    name: /I confirmed every retained exercise works with my exact equipment setup/,
  }).check();

  const routineSection = page.getByRole("heading", { name: "Routine from text" }).locator("..").locator("..");
  const layout = await routineSection.evaluate((root) => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    controls: [...root.querySelectorAll<HTMLElement>("button:enabled, input, select, textarea")]
      .filter((element) => {
        const input = element instanceof HTMLInputElement ? element : null;
        const target = input && (input.type === "checkbox" || input.type === "radio")
          ? input.closest("label") ?? input
          : element;
        const bounds = target.getBoundingClientRect();
        return bounds.width > 0 && (bounds.width < 40 || bounds.height < 40);
      })
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? element.closest("label")?.textContent?.trim() ?? element.textContent?.trim() ?? element.tagName,
        type: element instanceof HTMLInputElement ? element.type : element.tagName,
      })),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.controls).toEqual([]);

  const publish = page.getByRole("button", { name: "Publish reviewed Program", exact: true });
  await expect(publish).toBeEnabled();
  await publish.focus();
  await expect(publish).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/program$/);
  await expect(page.getByText("Two-day integrity plan", { exact: true })).toBeVisible();

  await page.goto("/today");
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await page.getByRole("checkbox", { name: /Include programmed warm-ups/ }).check();
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);

  const warmup = page.getByRole("region", { name: "Warm-up", exact: true });
  const labels = await warmup.locator("li").allTextContents();
  expect(labels.join("\n")).toMatch(/Easy bike warm-up[\s\S]*Hip circles[\s\S]*Empty bar[\s\S]*Half of working load/);
  const easyBike = warmup.locator("li").filter({ hasText: "Easy bike warm-up" });
  const easyBikeCheck = easyBike.getByRole("checkbox", { name: "Mark Easy bike warm-up complete", exact: true });
  await easyBikeCheck.focus();
  await page.keyboard.press("Enter");
  await warmup
    .getByRole("button", { name: "Review full plan", exact: true })
    .click();
  await expect(easyBike.getByRole("button", { name: "Undo completion", exact: true })).toBeVisible();
  await expect(easyBike.getByText("Saved", { exact: true })).toBeVisible();
  const emptyBar = warmup.locator("li").filter({ hasText: "Empty bar" }).first();
  const emptyBarCheck = emptyBar.getByRole("checkbox", { name: "Mark Empty bar complete", exact: true });
  await emptyBarCheck.focus();
  await page.keyboard.press("Enter");
  await expect(emptyBar.getByRole("button", { name: "Undo completion", exact: true })).toBeVisible();
  await expect(emptyBar.getByText("Saved", { exact: true })).toBeVisible();

  const current = page.getByTestId("current-exercise-card");
  await expect(current).toContainText("Set 1 of 3");
  await expect(current).toContainText("5 reps · 60 kg");
  await current.getByLabel("Total load").fill("60");
  await current.getByRole("textbox", { name: "Reps", exact: true }).fill("5");
  await current.getByRole("button", { name: "Log set", exact: true }).click();
  await expect(page.locator('[id^="logged-set-"]').first()).toContainText("60 lb");

  await page.getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ }).click();
  await page
    .getByLabel("Why are you finishing this workout early?")
    .selectOption("user_choice");
  await page.getByText("Optional note and fatigue", { exact: true }).click();
  await page.getByPlaceholder("Session note (optional) — how did it go?").fill("PII-01 synthetic journey");
  await page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText("PII-01 synthetic journey", { exact: true })).toBeVisible();
  await expect(page.getByText(/60 lb × 5/)).toBeVisible();
  const exported = await page.request.get("/api/export/json");
  expect(exported.ok()).toBe(true);
  const exportText = await exported.text();
  expect(exportText).toContain("Two-day integrity plan");
  expect(exportText).toContain("Easy bike warm-up");
  expect(exportText).toContain("beforeSlotLineageId");
  await prefetches.settle();
  expect(errors.filter(
    (message) =>
      !isCorrelatedWebKitRscPrefetchCancellation(
        message,
        browserName,
        prefetches.observedUrls,
      ),
  )).toEqual([]);
});

test("supports enlarged text and an explicit discard without publishing", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings");
  await page.getByRole("radio", { name: /Extra large/ }).click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe("extra-large");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/program/import");
  const previousReview = page.getByRole("heading", { name: "Review the proposed Program" });
  if (await previousReview.isVisible()) {
    await page.getByRole("button", { name: "Discard staged review", exact: true }).click();
    await expect(page.getByLabel("Paste your Program")).toBeVisible();
  }
  await page.getByLabel("Paste your Program").fill(`Program: Discard me
Day 1 — Bodyweight
Warm-up: March in place | reps=?
Bodyweight Squat 2x10, rest 1 min`);
  await page.getByRole("button", { name: "Parse for review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review the proposed Program" })).toBeVisible();
  await expect(page.getByText("Warm-up repetitions are explicitly unknown.")).toBeVisible();
  const populatedLayout = await page.evaluate(() => {
    const actionBar = document.querySelector("div.sticky");
    const navigation = document.querySelector('nav[aria-label="Primary navigation"]');
    const navigationTop = navigation?.getBoundingClientRect().top ?? window.innerHeight;
    const actions = [...(actionBar?.querySelectorAll("button") ?? [])].map((button) => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      return {
        height: bounds.height,
        disabled: button.disabled,
        aboveNavigation: bounds.bottom <= navigationTop + 1,
        hitTarget: hit === button || button.contains(hit),
      };
    });
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      actions,
    };
  });
  expect(populatedLayout.scrollWidth).toBeLessThanOrEqual(populatedLayout.clientWidth + 1);
  expect(populatedLayout.actions).toHaveLength(2);
  expect(populatedLayout.actions.every(
    (action) =>
      action.height >= 40 &&
      action.aboveNavigation &&
      (action.disabled || action.hitTarget),
  )).toBe(true);
  const instruction = page.getByRole("textbox", {
    name: /Bodyweight, warm-up 1, March in place, instruction$/,
  });
  await instruction.focus();
  await expect(instruction).toBeFocused();
  await page.getByRole("button", { name: "Discard staged review", exact: true }).click();
  await expect(page.getByLabel("Paste your Program")).toBeVisible();
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth + 1);
});
