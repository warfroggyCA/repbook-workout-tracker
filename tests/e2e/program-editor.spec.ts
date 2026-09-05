import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page
    .getByPlaceholder("allowlisted email")
    .fill("owner@example.com");
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function expectSaved(page: Page) {
  await expect(page.getByRole("status")).toContainText("All changes saved");
}

async function assertNoHorizontalOverflow(page: Page) {
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => ({
    fontSize: document.documentElement.dataset.fontSize,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    containers: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .slice(0, 30)
      .map((element) => ({
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 50),
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        className: element.className,
      })),
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.width > 0 &&
          (rect.left < -1 ||
            rect.right > document.documentElement.clientWidth + 1),
      )
      .slice(0, 12)
      .map(({ element, rect }) => ({
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 50),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        className: element.className,
      })),
  }));
  expect(
    result.scrollWidth,
    JSON.stringify({
      fontSize: result.fontSize,
      offenders: result.offenders,
      containers: result.containers,
    }),
  ).toBeLessThanOrEqual(result.clientWidth + 1);
}

test("keeps one exercise identity and supports normal set and picker editing", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);

  const editor = page.locator("article[aria-labelledby]").first();
  const labelId = await editor.getAttribute("aria-labelledby");
  expect(labelId).toBeTruthy();
  const exerciseName = await page.locator(`#${labelId}`).textContent();
  expect(exerciseName).toBeTruthy();
  await expect(
    editor.locator("../..").getByText(exerciseName ?? "", { exact: true }),
  ).toHaveCount(1);

  const workSets = editor.getByLabel("Work sets");
  const originalSets = await workSets.inputValue();
  await workSets.click();
  await workSets.press("Backspace");
  await expect(workSets).toHaveValue("");
  await workSets.pressSequentially(originalSets);
  await workSets.press("Tab");
  await expect(workSets).toHaveValue(originalSets);

  await workSets.click();
  await workSets.press("Backspace");
  await expect(workSets).toHaveValue("");
  await workSets.press("Tab");
  await expect(workSets).toHaveValue(originalSets);

  const changedSets = originalSets === "5" ? "6" : "5";
  await workSets.fill(changedSets);
  await workSets.press("Tab");
  await expect(workSets).toHaveValue(changedSets);

  await workSets.fill("99");
  await workSets.press("Tab");
  await expect(workSets).toHaveValue("20");

  await workSets.fill(originalSets);
  await workSets.press("Tab");
  await expect(workSets).toHaveValue(originalSets);
  await expectSaved(page);

  await editor
    .getByRole("button", { name: "Replace exercise", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Replace this exercise",
    exact: true,
  });
  await picker.getByLabel("Search exercise library").fill("Bird Dog");
  await expect(
    picker.getByRole("button", { name: "View details for Bird Dog" }),
  ).toBeVisible();
  await expect(picker.getByText("Bird Dog", { exact: true })).toHaveCount(1);
  await expect(picker.getByText("1 variant", { exact: true })).toHaveCount(0);

  await picker.getByRole("button", { name: "Clear exercise search" }).click();
  const benchPressFamily = picker.getByRole("button", {
    name: /^Bench Press \d+ variants$/,
  });
  await expect(benchPressFamily).toHaveAttribute("aria-expanded", "false");
  await benchPressFamily.click();
  await expect(benchPressFamily).toHaveAttribute("aria-expanded", "true");
  await expect(
    picker.getByRole("button", {
      name: "View details for Barbell Bench Press",
      exact: true,
    }),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("program-editor-ipad-polish.png"),
    fullPage: true,
  });
});

test("autosaves, resolves tab conflicts, publishes v2, and restores v1 as v3", async ({
  page,
  context,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      errors.push(message.text());
  });

  await signIn(page);
  await page.goto("/program/edit");
  await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();
  const dayAdvanced = page
    .locator("details")
    .filter({ hasText: "Advanced session options" })
    .first();
  await expect(dayAdvanced).not.toHaveAttribute("open", "");
  await expectSaved(page);
  await page.screenshot({
    path: "output/playwright/phase2-evidence/before-legacy-program-editor.png",
    fullPage: true,
  });
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const sidebar = await page.locator("aside").boundingBox();
      const heading = await page
        .getByRole("heading", { level: 1, name: /^Edit / })
        .boundingBox();
      return sidebar && heading
        ? heading.x - (sidebar.x + sidebar.width)
        : Number.NEGATIVE_INFINITY;
    })
    .toBeGreaterThanOrEqual(0);

  const second = await context.newPage();
  second.on("pageerror", (error) => errors.push(error.message));
  second.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      errors.push(message.text());
  });
  await second.goto("/program/edit");
  await expectSaved(second);
  await page.getByLabel("Program name").fill("Versioned Strength Plan");
  await second.getByLabel("Program name").fill("Conflicting Tab Plan");
  await expect
    .poll(
      async () =>
        (await page
          .getByText("Another tab has a newer server draft", { exact: true })
          .count()) +
        (await second
          .getByText("Another tab has a newer server draft", { exact: true })
          .count()),
    )
    .toBeGreaterThan(0);
  const conflicted = (await page
    .getByText("Another tab has a newer server draft", { exact: true })
    .count())
    ? page
    : second;
  await conflicted
    .getByRole("button", { name: "Load server draft", exact: true })
    .click();
  await expectSaved(conflicted);
  await second.close();
  await page.reload();
  await expectSaved(page);

  await context.setOffline(true);
  await page
    .getByLabel("Program name")
    .fill("Versioned Strength Plan — offline recovery");
  await expect(page.getByRole("status")).toContainText("offline", {
    ignoreCase: true,
  });
  await context.setOffline(false);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectSaved(page);
  await page.reload();
  await expect(page.getByLabel("Program name")).toHaveValue(
    "Versioned Strength Plan — offline recovery",
  );
  await page.getByLabel("Program name").fill("Versioned Strength Plan");
  await expectSaved(page);
  await expect(page.getByLabel("Program name")).toHaveValue(
    "Versioned Strength Plan",
  );

  await dayAdvanced.locator("summary").click();
  await page.getByLabel("Day name").first().fill("Foundation Day");
  await page.getByLabel("Main goal").selectOption("hypertrophy");
  await page
    .getByLabel("Fatigue preference (saved context)")
    .selectOption("low");
  await page.getByLabel("Usual time — minimum").fill("0");
  await expect(page.getByLabel("Usual time — minimum")).toHaveValue("0");
  await page.getByLabel("Usual time — maximum").fill("999");
  await expect(page.getByLabel("Usual time — maximum")).toHaveValue("999");
  await page.getByLabel("Shortest useful session").fill("999");
  await expect(page.getByLabel("Shortest useful session")).toHaveValue("999");
  await page.getByLabel("Usual time — minimum").fill("40");
  await page.getByLabel("Usual time — maximum").fill("60");
  await page.getByLabel("Shortest useful session").fill("30");
  await page
    .getByLabel("Day notes")
    .first()
    .fill("Main strength and technique work.");
  await page.getByRole("textbox", { name: "Warm-up instructions (optional)" }).fill(
    "Five minutes easy cardio, shoulder circles, then two gradual ramp-up sets.",
  );
  const firstExercise = page.locator("article[aria-labelledby]").first();
  await firstExercise.getByLabel("Work sets").fill("4");
  const slotAdvanced = firstExercise
    .locator("details")
    .filter({ hasText: "Advanced session options" });
  await expect(slotAdvanced).not.toHaveAttribute("open", "");
  await slotAdvanced.locator("summary").click();
  await firstExercise.getByLabel("Minimum useful sets").fill("99");
  await expect(firstExercise.getByLabel("Minimum useful sets")).toHaveValue("4");
  await firstExercise.getByLabel("Preferred sets (saved context)").fill("0");
  await expect(firstExercise.getByLabel("Preferred sets (saved context)")).toHaveValue("4");
  await firstExercise.getByLabel("Minimum useful sets").fill("2");
  await firstExercise.getByLabel("Preferred sets (saved context)").fill("5");
  await firstExercise.getByLabel("Minimum reps").fill("6");
  await firstExercise.getByLabel("Maximum reps").fill("10");
  await firstExercise.getByLabel("Minutes").selectOption("2");
  await firstExercise.getByLabel("Seconds").selectOption("0");
  await firstExercise.getByLabel("Target load").fill("80");
  await firstExercise.getByLabel("Load unit").selectOption("kg");
  await firstExercise.getByLabel("How weight should increase").selectOption("hold");
  await firstExercise
    .getByLabel("Replacement preference (saved for later)")
    .selectOption("exact_only");
  await firstExercise
    .getByLabel("Omission preference (saved for later)")
    .selectOption("never");
  await firstExercise
    .getByLabel("Exercise notes")
    .fill("Pause briefly and keep the brace steady.");
  await expect(firstExercise.getByLabel("Move to another day")).toHaveCount(0);
  await expect(firstExercise.getByLabel("Warm-up notes")).toHaveCount(0);
  await expect(firstExercise.getByText("Work-set cues", { exact: true })).toHaveCount(0);
  await expectSaved(page);
  await page.reload();
  await dayAdvanced.locator("summary").click();
  await expect(page.getByLabel("Main goal")).toHaveValue("hypertrophy");
  await expect(page.getByLabel("Usual time — minimum")).toHaveValue("40");
  await expect(page.getByLabel("Usual time — maximum")).toHaveValue("60");
  await expect(page.getByLabel("Shortest useful session")).toHaveValue("30");
  await slotAdvanced.locator("summary").click();
  await expect(firstExercise.getByLabel("Minimum useful sets")).toHaveValue("2");
  await expect(firstExercise.getByLabel("Preferred sets (saved context)")).toHaveValue("5");

  await page
    .getByRole("button", { name: "Group exercises", exact: true })
    .first()
    .click();
  await page.getByLabel(/^Select /).nth(0).check();
  await page.getByLabel(/^Select /).nth(1).check();
  await page.getByRole("button", { name: "Make superset", exact: true }).click();
  const groupDetails = page.locator("details").filter({ hasText: "Superset:" }).first();
  await groupDetails.locator("summary").click();
  const roundRest = groupDetails.getByRole("group", { name: "Rest after each round" });
  await roundRest.getByLabel("Minutes").selectOption("1");
  await roundRest.getByLabel("Seconds").selectOption("15");
  await expectSaved(page);

  for (const fontSize of [
    { key: "compact", percent: 100 },
    { key: "default", percent: 115 },
    { key: "large", percent: 130 },
    { key: "extra-large", percent: 145 },
  ] as const) {
    await page.evaluate(({ key }) => {
      document.documentElement.dataset.fontSize = key;
    }, fontSize);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ),
        ),
      )
      .toBeCloseTo((16 * fontSize.percent) / 100, 1);

    for (const viewport of [
      { width: 320, height: 760 },
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await assertNoHorizontalOverflow(page);
    }
  }

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to publish" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Before you publish" })).toBeVisible();
  const futureChanges = page
    .getByRole("heading", { name: "What will change for future workouts" })
    .locator("../../..");
  await expect(futureChanges).toBeVisible();
  await expect(page.getByText(/exact change list for saved draft revision/i)).toBeVisible();
  await futureChanges.locator("details").first().locator("summary").click();
  await expect(page.getByText("Current Program", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("Future Program after publication", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page
      .locator("details")
      .filter({ hasText: /Show \d+ affected (?:exercise|exercises|day|days|item|items)/ })
      .first()
      .locator("summary"),
  ).toBeVisible();
  await expect(page.getByText(/Matching past workouts:/)).toHaveCount(0);
  await expect(
    page.getByText(/does not make the warning more or less certain/i),
  ).toHaveCount(0);
  await expect(
    page.getByText(/changes? compared with the current Program/i),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Publish future Program", exact: true })
    .click();
  await expect(
    page.getByText("Future Program published", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Version 2 is now used for workouts started from this point forward/i),
  ).toBeVisible();

  await page.goto("/program");
  await expect(page.getByRole("heading", { name: "Program checks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "When this version was published" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "What has changed since publication",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/phase2-evidence/after-published-intent-preflight.png",
    fullPage: true,
  });
  await page.goto("/program/edit");

  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^v2 · Versioned Strength Plan$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect v1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inspect v1 · 3-Day Full Body" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close inspection", exact: true }).click();
  const v2DownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export v2", exact: true }).click();
  const v2Download = await v2DownloadPromise;
  const v2DownloadPath = testInfo.outputPath("program-v2.json");
  await v2Download.saveAs(v2DownloadPath);
  const exportedV2 = JSON.parse(await readFile(v2DownloadPath, "utf8")) as {
    schemaVersion: number;
    version: {
      documentSchemaVersion: string;
      publicationPreflight: unknown;
    };
    document: {
      schemaVersion: string;
      days: Array<{ intent: unknown; exercises: Array<{ intent: unknown }> }>;
    };
  };
  expect(exportedV2).toMatchObject({
    schemaVersion: 2,
    version: {
      documentSchemaVersion: "3",
      publicationPreflight: expect.objectContaining({
        algorithmVersion: "phase2-rule-range-v1",
      }),
    },
    document: {
      schemaVersion: "3",
      days: expect.arrayContaining([
        expect.objectContaining({
          intent: expect.objectContaining({
            primaryOutcome: "hypertrophy",
            targetDuration: { minMinutes: 40, maxMinutes: 60 },
            minimumUsefulDurationMinutes: 30,
          }),
          exercises: expect.arrayContaining([
            expect.objectContaining({
              intent: expect.objectContaining({
                role: "anchor",
                minimumDose: { unit: "sets", value: 2 },
                idealDose: { unit: "sets", value: 5 },
              }),
            }),
          ]),
        }),
      ]),
    },
  });
  await page
    .getByRole("button", { name: "Compare with current", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "v1 compared with current" }),
  ).toBeVisible();

  const exportButton = page.getByRole("button", {
    name: "Export v1",
    exact: true,
  });
  await expect(exportButton).toHaveAttribute(
    "href",
    /\/api\/program\/versions\/.+\/export/,
  );
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("workout-tracker-program-v1.json");
  const downloadPath = testInfo.outputPath("program-v1.json");
  await download.saveAs(downloadPath);
  const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
    format: string;
    version: { versionNo: number };
    document: { name: string };
  };
  expect(exported).toMatchObject({
    format: "workout-tracker-program-version",
    version: { versionNo: 1 },
    document: { name: "3-Day Full Body" },
  });
  await page
    .getByRole("button", { name: "Restore as new draft", exact: true })
    .click();
  await expect(page.getByText(/replaces the open draft/i)).toBeVisible();
  await page
    .getByRole("button", { name: "Create restore draft", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Edit", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expectSaved(page);

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to publish" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish future Program", exact: true })
    .click();
  await expect(
    page.getByText(/Version 3 is now used for workouts started from this point forward/i),
  ).toBeVisible();
  await page.goto("/program");
  await expect(page.getByText("v3", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "3-Day Full Body", exact: true }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("a warm-up-only edit produces one clear review and stays reversible", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);

  const advancedOptions = page
    .locator("details")
    .filter({ hasText: "Advanced session options" });
  expect(await advancedOptions.count()).toBeGreaterThan(0);
  await expect(advancedOptions.first()).not.toHaveAttribute("open", "");
  await expect(
    page.getByText("Later calibration eligible", { exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("textbox", { name: "Warm-up instructions (optional)" })
    .fill(
      "Two minutes easy\nEight smooth push-ups\nTwo gradual ramp-up sets",
    );
  await expectSaved(page);

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Check Program",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to publish", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/change compared with the current Program/i),
  ).toHaveCount(0);
  await expect(page.getByText(/warm-up added/i)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Training summary" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Publish future Program", exact: true }),
  ).toBeEnabled();

  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page).toHaveURL(/\/program$/);
});

test("full replacement creates a reviewable Program proposal without auto-publishing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      errors.push(message.text());
    }
  });

  await signIn(page);
  await page.goto("/program/edit");
  await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();
  await expectSaved(page);

  const longFormPlan = [
    "Replace my Program with however many days this complete specification contains.",
    "Preserve every warm-up, ramp set, work set, rest, rep range, group, cue, optional exercise, and progression rule.",
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `PLAN DETAIL ${index + 1}: Keep this explicit coaching cue attached to the appropriate day or exercise.`,
    ),
  ].join("\n");
  expect(longFormPlan.length).toBeGreaterThan(6_000);
  await page.getByLabel("Create full replacement").check();
  await page.getByLabel("What should change?").fill(longFormPlan);
  await page
    .getByRole("button", { name: "Compare and propose changes", exact: true })
    .click();
  await expect(page.getByText("Proposal ready to review", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(/0 added · 1 changed/)).toBeVisible();

  await page.getByLabel(/Select change: Replace the entire Program/).check();

  await page
    .getByRole("button", { name: "Apply selected changes", exact: true })
    .click();
  await expect(
    page.getByText("Proposal applied to the draft", { exact: true }),
  ).toBeVisible();
  await expectSaved(page);

  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to publish" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Publish future Program", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Version 3 is now used for workouts started from this point forward/i),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page.getByRole("button", { name: "Discard draft", exact: true }).last().click();
  await expect(page).toHaveURL(/\/program$/);

  expect(errors).toEqual([]);
});

test("day tabs and day warm-up copy controls remain keyboard and omission safe", async ({ page }) => {
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);
  const dayTabs = page.getByRole("tablist", { name: "Edit Program days" }).getByRole("tab");
  expect(await dayTabs.count()).toBeGreaterThan(1);
  const firstHref = await dayTabs.first().getAttribute("href");
  await dayTabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(dayTabs.nth(1)).toBeFocused();
  expect(page.url()).toContain(firstHref?.split("?")[0] ?? "/program/edit");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`day=${encodeURIComponent((await dayTabs.nth(1).getAttribute("href"))!.split("day=")[1])}`));

  await dayTabs.first().click();
  const warmup = page.getByRole("textbox", { name: "Warm-up instructions (optional)" });
  await warmup.fill("Five minutes easy, then two ramp-up sets.");
  await expectSaved(page);
  await page.getByRole("button", { name: "Copy to days", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Copy this warm-up" });
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: "Copy warm-up", exact: true }).click();
  await expectSaved(page);

  await dayTabs.nth(1).click();
  await expect(warmup).toHaveValue("Five minutes easy, then two ramp-up sets.");
  await warmup.fill("A different existing warm-up.");
  await expectSaved(page);
  await dayTabs.first().click();
  await page.getByRole("button", { name: "Apply to all", exact: true }).click();
  await page.getByRole("button", { name: "Replace warm-ups", exact: true }).click();
  await expectSaved(page);
  await dayTabs.nth(1).click();
  await expect(warmup).toHaveValue("Five minutes easy, then two ramp-up sets.");
  await page.getByRole("button", { name: "Clear this day", exact: true }).click();
  await expect(warmup).toHaveValue("");
});

test("partial text update applies only selected explicit changes", async ({ page }) => {
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);
  await page.getByLabel("Update current Program").check();
  await page.getByLabel("What should change?").fill(
    "Change Barbell Back Squat to 4 sets of 5 reps with 2 min 30 sec rest. Leave every unmentioned day and exercise unchanged.",
  );
  await page.getByRole("button", { name: "Compare and propose changes", exact: true }).click();
  await expect(page.getByText("Proposal ready to review", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Select change: Change Barbell Back Squat/)).toBeChecked();
  await page.getByRole("button", { name: "Apply selected changes", exact: true }).click();
  await expectSaved(page);
  const editor = page.locator("article[aria-labelledby]").first();
  await expect(editor.getByLabel("Work sets")).toHaveValue("4");
  await expect(editor.getByLabel("Minimum reps")).toHaveValue("5");
  await expect(editor.getByLabel("Minutes")).toHaveValue("2");
  await expect(editor.getByLabel("Seconds")).toHaveValue("30");
});

test("builds, reviews, and explicitly accepts one deterministic session proposal without changing the Program", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Check Program", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Ready to publish" })).toBeVisible();
  await page.getByRole("button", { name: "Publish future Program", exact: true }).click();
  await expect(
    page.getByText(/workouts started from this point forward/i),
  ).toBeVisible();
  await page.goto("/program");
  const versionBefore = await page.locator("header").getByText(/^v\d+$/).textContent();
  await page.screenshot({ path: testInfo.outputPath("compiler-before.png"), fullPage: true });
  await page.getByText("Build session proposal", { exact: true }).click();
  await expect(page).toHaveTitle(/Build session proposal/);
  await expect(page.getByText("Nothing here changes the saved Program", { exact: false })).toBeVisible();
  await page.getByLabel("Time available").fill("90");
  await page.getByLabel("Energy context").selectOption("low");
  await page.getByRole("button", { name: "Review deterministic proposal", exact: true }).click();
  await expect(page).toHaveURL(/\/program\/compile\/[0-9a-f-]+$/);
  await expect(page).toHaveTitle(/Review session proposal/);
  await expect(page.getByRole("heading", { name: "Proposed session", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every choice", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Intent result", exact: true })).toBeVisible();
  await expect(page.getByText(/no dose authority/i)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("compiler-after-review.png"), fullPage: true });

  const proposalPath = new URL(page.url()).pathname;
  const recoveryPage = await context.newPage();
  await recoveryPage.goto("/program");
  await expect(recoveryPage.getByRole("heading", { name: "Resume session proposal", exact: true })).toBeVisible();
  await recoveryPage.getByText("Review proposal", { exact: true }).click();
  await expect(recoveryPage).toHaveURL(new RegExp(`${proposalPath}$`));
  await recoveryPage.close();

  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.dataset.fontSize = "extra-large"; });
  await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeCloseTo(23.2, 1);
  await assertNoHorizontalOverflow(page);
  const reviewCheckbox = page.getByRole("checkbox", { name: /I reviewed the exercises/ });
  await reviewCheckbox.focus();
  await expect(reviewCheckbox).toBeFocused();
  await reviewCheckbox.check();
  await page.getByRole("button", { name: "Accept and start workout", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

  const programCheck = await context.newPage();
  await programCheck.goto("/program");
  await expect(programCheck.locator("header").getByText(versionBefore ?? "v3", { exact: true })).toBeVisible();
  await programCheck.close();

  const discard = page.getByRole("button", { name: "Discard workout", exact: true });
  if (await discard.count()) {
    await discard.click();
    await page
      .getByRole("dialog", { name: /Discard .*\?$/ })
      .getByRole("button", { name: "Confirm discard", exact: true })
      .click();
  }
  expect(errors).toEqual([]);
});

test("edits minutes, copies day options, and drops an exercise around a non-contiguous group", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/program/edit");
  await expectSaved(page);
  const state = await (await page.request.get("/api/program/draft")).json();
  const document = state.draft.document;
  const day = document.days[0];
  expect(day.exercises.length).toBeGreaterThanOrEqual(5);
  day.intent.identity = { kind: "anchor_slots", anchorSlotLineageIds: [day.exercises[0].lineageId] };
  document.days[1].intent.identity = { kind: "movement_balance", anchorSlotLineageIds: [] };
  const [lead, a, moving, b, c] = day.exercises;
  const groupKey = crypto.randomUUID();
  day.supersets = [{ key: groupKey, name: "Synthetic three-member group", structureStatus: "canonical", plannedRounds: 3, restBetweenMembersSec: 0, restBetweenRoundsSec: 75, restAfterRoundSec: 75 }];
  day.exercises.forEach((slot: { supersetKey: string | null; groupMemberOrderIdx: number | null }) => { slot.supersetKey = null; slot.groupMemberOrderIdx = null; });
  [a, b, c].forEach((slot, index) => {
    slot.supersetKey = groupKey; slot.groupMemberOrderIdx = index; slot.sets = 3; slot.setNotes = [null, null, null];
    slot.intent.minimumDose = { unit: "sets", value: 1 };
    slot.intent.idealDose = { unit: "sets", value: 3 };
  });
  day.warmupItems = [{ key: crypto.randomUUID(), beforeSlotLineageId: moving.lineageId, label: "Synthetic anchored practice", reps: 6, load: null, loadUnit: null, loadPercent: null, loadText: null, notes: null }];
  const seeded = await page.request.put("/api/program/draft", { headers: { origin: "http://127.0.0.1:3100" }, data: { draftId: state.draft.id, expectedRevision: state.draft.revision, mutationId: crypto.randomUUID(), document } });
  expect(await seeded.json()).toMatchObject({ status: "saved" });
  await page.reload();
  await expectSaved(page);
  const advanced = page.locator("details").filter({ has: page.locator("summary", { hasText: "Advanced session options" }) }).first();
  await advanced.locator("summary").click();
  const minimum = page.getByLabel("Usual time — minimum", { exact: true });
  await minimum.fill("5");
  await expectSaved(page);
  await minimum.press("Backspace");
  await expect(minimum).toHaveValue("");
  await expect(page.getByRole("status")).not.toContainText("All changes saved");
  await page.reload();
  await advanced.locator("summary").click();
  await expect(minimum).toHaveValue("");
  await minimum.fill("42");
  await page.getByLabel("Usual time — maximum", { exact: true }).fill("80");
  await page.getByLabel("Shortest useful session", { exact: true }).fill("20");
  await expectSaved(page);
  await page.getByRole("button", { name: "Use for all days", exact: true }).click();
  await expectSaved(page);
  const copied = (await (await page.request.get("/api/program/draft")).json()).draft.document;
  for (const [index, result] of copied.days.entries()) {
    expect(result.intent.targetDuration).toEqual({ minMinutes: 42, maxMinutes: 80 });
    expect(result.intent.identity).toEqual(document.days[index].intent.identity);
  }
  await advanced.locator("summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  const source = page.locator(`[data-program-slot-lineage="${moving.lineageId}"]`);
  const destination = page.locator(`[data-program-slot-lineage="${a.lineageId}"]`);
  await source.scrollIntoViewIfNeeded();
  const handle = source.getByRole("button", { name: /^Drag .* to reorder$/ });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await destination.scrollIntoViewIfNeeded();
  const target = await destination.boundingBox();
  expect(target).not.toBeNull();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 10, { steps: 8 });
  await expect(page.getByText("Drop here", { exact: true })).toBeVisible();
  await page.mouse.up();
  await expectSaved(page);
  const moved = (await (await page.request.get("/api/program/draft")).json()).draft.document.days[0];
  expect(moved.exercises.slice(0, 5).map((slot: { lineageId: string }) => slot.lineageId)).toEqual([lead.lineageId, moving.lineageId, a.lineageId, b.lineageId, c.lineageId]);
  expect(moved.supersets).toEqual(day.supersets);
  expect(moved.warmupItems).toEqual(day.warmupItems);
  await page.reload();
  await expectSaved(page);
  await source.getByRole("button", { name: /^Drag .* to reorder$/ }).press("ArrowDown");
  await expectSaved(page);
  const keyboard = (await (await page.request.get("/api/program/draft")).json()).draft.document.days[0];
  expect(keyboard.exercises[2].lineageId).toBe(moving.lineageId);
  expect(keyboard.warmupItems).toEqual(day.warmupItems);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("reorder-mobile.png"), fullPage: true });
});


test("publishes loaded seconds per side and records the performed measurement on mobile", async ({ page }, testInfo) => {
  await signIn(page);
  // Prior compiler coverage deliberately leaves an active synthetic workout.
  const discardExisting = page.getByRole("button", { name: "Discard this workout", exact: true });
  if (await discardExisting.count()) {
    await discardExisting.click();
    await page.getByRole("dialog", { name: /Discard .+\?/ }).getByRole("button", { name: "Confirm discard", exact: true }).click();
    await expect(discardExisting).toHaveCount(0);
  }
  await page.goto("/program/edit");
  await expectSaved(page);
  const state = (await (await page.request.get("/api/program/draft")).json()).draft.document;
  const editor = page.locator("article[aria-labelledby]").first();
  await editor.getByRole("button", { name: "Replace exercise", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Replace this exercise", exact: true });
  await picker.getByLabel("Search exercise library").fill("Kettlebell Suitcase Carry");
  await picker.getByRole("button", { name: "View details for Kettlebell Suitcase Carry", exact: true }).click();
  await picker.getByRole("button", { name: "Replace exercise", exact: true }).click();
  await page.getByRole("button", { name: /^Kettlebell Suitcase Carry Exercise 1 / }).click();
  await editor.getByLabel("Prescription measurement").selectOption("time_per_side");
  await editor.getByLabel("Minimum seconds per side").fill("30");
  await editor.getByLabel("Maximum seconds per side").fill("45");
  await editor.getByLabel("Target load").fill("20");
  await expect(editor.getByLabel("Minimum reps", { exact: true })).toHaveCount(0);
  await expectSaved(page);
  await page.reload();
  await expect(editor.getByLabel("Minimum seconds per side")).toHaveValue("30");
  await page.screenshot({ path: testInfo.outputPath("timed-prescription-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Check Program", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Ready to publish" })).toBeVisible();
  await expect(page.getByText(/30–45 sec\/side/).first()).toBeVisible();
  await page.getByRole("button", { name: "Publish future Program", exact: true }).click();
  await expect(page.getByText("Future Program published", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/today");
  const alternateDays = page.getByTestId("alternate-program-days");
  await alternateDays.locator("summary").click();
  await alternateDays.getByRole("button", { name: state.days[0].name, exact: false }).click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const timedInput = page.getByLabel("Seconds per side — both sides completed", { exact: true });
  await expect(timedInput).toBeVisible();
  await timedInput.fill("35");
  await page.screenshot({ path: testInfo.outputPath("timed-entry-mobile.png"), fullPage: true });
  const log = page.getByRole("button", { name: /^Log set(?: 1)?$/ }).filter({ visible: true }).first();
  await page.context().setOffline(true);
  await log.click();
  await expect(page.getByText(/35 sec\/side/).first()).toBeVisible();
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("workout-tracker:workout-set-outbox:v1");
    return raw ? (JSON.parse(raw).entries?.length ?? 0) : 0;
  })).toBe(0);
  await page.reload();
  await expect(page.getByText(/35 sec\/side/).first()).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await page.goto("/today");
  await page.getByRole("button", { name: "Discard this workout", exact: true }).click();
  await page.getByRole("dialog", { name: /Discard .+\?/ }).getByRole("button", { name: "Confirm discard", exact: true }).click();

});
