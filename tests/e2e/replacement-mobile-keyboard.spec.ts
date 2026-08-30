import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  waitForHydratedReactChangeHandler,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscLinkCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

test.describe.configure({ mode: "serial" });

const EXPECTED_APP_SHELL_PREFETCHES = new Set([
  "/today",
  "/history",
  "/coach",
  "/program",
  "/settings",
]);

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function discardActiveWorkout(page: Page) {
  const resume = page.getByRole("button", { name: "Resume workout", exact: true });
  if ((await resume.count()) === 0) return;
  await waitForHydratedReactHandler(resume);
  await resume.click();
  await expect(page).toHaveURL(
    /\/session\/[0-9a-f-]+(?:#workout-rest-status)?$/,
  );
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review workout finish|Finish workout)$/ })
    .click();
  await page
    .getByRole("dialog", { name: "Finish workout" })
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

async function startWorkout(page: Page) {
  await discardActiveWorkout(page);
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(page.getByTestId("current-exercise-card")).toBeVisible();
}

async function inspectSearchResult(picker: Locator, name: string) {
  const search = picker.getByLabel("Search exercise library");
  const result = picker.getByRole("button", {
    name: `View details for ${name}`,
    exact: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(search).toBeEditable();
    await search.fill("");
    await search.pressSequentially(name, { delay: 10 });
    try {
      await expect(result).toBeVisible({ timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  await result.click();
}

async function returnToSearchResults(picker: Locator) {
  const back = picker.getByRole("button", {
    name: "Back to results",
    exact: true,
  });
  await waitForHydratedReactHandler(back);
  await back.click();
  const search = picker.getByLabel("Search exercise library");
  await expect(search).toBeEditable();
  await search.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  );
  await expect(picker).toBeVisible();
  await expect(search).toBeEditable();
}

async function expectKeyboardGeometry(page: Page, picker: Locator) {
  await expect(async () => {
    const geometry = await picker.evaluate((dialog) => {
      const viewport = window.visualViewport;
      const visibleTop = viewport?.offsetTop ?? 0;
      const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
      const dialogRect = dialog.getBoundingClientRect();
      const focusedRect = document.activeElement?.getBoundingClientRect() ?? null;
      const scrollOwners = [...dialog.querySelectorAll<HTMLElement>("*")]
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            /(auto|scroll)/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1
          );
        })
        .map(
          (element) =>
            element.dataset.testid ?? element.dataset.slot ?? element.tagName,
        );
      return {
        visibleTop,
        visibleBottom,
        dialog: {
          top: dialogRect.top,
          bottom: dialogRect.bottom,
          left: dialogRect.left,
          right: dialogRect.right,
        },
        focused: focusedRect
          ? { top: focusedRect.top, bottom: focusedRect.bottom }
          : null,
        scrollOwners,
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(geometry.dialog.top).toBeGreaterThanOrEqual(geometry.visibleTop - 1);
    expect(geometry.dialog.bottom).toBeLessThanOrEqual(
      geometry.visibleBottom + 1,
    );
    expect(geometry.dialog.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.dialog.right).toBeLessThanOrEqual(
      (await page.evaluate(() => document.documentElement.clientWidth)) + 1,
    );
    expect(geometry.focused).not.toBeNull();
    expect(geometry.focused?.top ?? -1).toBeGreaterThanOrEqual(
      geometry.visibleTop - 1,
    );
    expect(
      geometry.focused?.bottom ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(geometry.visibleBottom + 1);
    expect(geometry.scrollOwners).toEqual(["exercise-picker-scroll"]);
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
}

test("keeps unrestricted replacement truthful and reachable through mobile keyboard resize", async ({
  browserName,
  page,
}) => {
  const unexpectedErrors: string[] = [];
  const nextRscPrefetches = observeNextRscPrefetches(page, browserName);
  let expectedRejectedRequest = false;
  const recordUnexpected = (text: string) => {
    unexpectedErrors.push(text);
  };
  page.on("pageerror", (error) => {
    recordUnexpected(error.message);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const isInjectedRejection =
      expectedRejectedRequest &&
      text ===
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
    if (!isInjectedRejection) {
      recordUnexpected(text);
    }
  });

  await signIn(page);
  await page.goto("/settings");
  const extraLargeText = page.getByRole("radio", { name: /Extra large/ });
  if (!(await extraLargeText.isChecked())) {
    await extraLargeText.click();
    await expect(
      page.getByText("Saved to your profile.", { exact: true }),
    ).toBeVisible();
  }
  await expect(extraLargeText).toBeChecked();
  await page.goto("/today");
  await startWorkout(page);

  const card = page.getByTestId("current-exercise-card");
  const originalExerciseName = await card
    .getByRole("heading", { level: 2 })
    .innerText();
  const preparation = page.getByTestId("session-preparation-panel");
  await expect(preparation).toContainText(originalExerciseName);
  const draftIdentity = await card.getAttribute("data-draft-identity");
  expect(draftIdentity).not.toBeNull();
  const weight = card.getByLabel(/^(Weight|Total load|Displayed load)/);
  const reps = card.getByLabel("Reps", { exact: true });
  await waitForHydratedReactChangeHandler(weight);
  await waitForHydratedReactChangeHandler(reps);
  await weight.fill("77");
  await reps.fill("9");
  await expect(weight).toHaveValue("77");
  await expect(reps).toHaveValue("9");

  // WebKit once exposed a delayed controlled-input event whose transient DOM
  // value was the non-finite string "NaN". Repbook must keep the last valid
  // athlete-entered load instead of turning that implementation detail into a
  // visible or loggable value.
  await weight.evaluate((element) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    valueSetter.call(input, "NaN");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(weight).toHaveValue("77");

  const setOptions = card.locator("details", { hasText: "Set options" });
  const setOptionsSummary = setOptions.locator(":scope > summary");
  const withSetOptionsOpen = async (action: () => Promise<void>) => {
    await expect(async () => {
      if ((await setOptions.getAttribute("open")) == null) {
        await setOptionsSummary.focus({ timeout: 3_000 });
        await setOptionsSummary.press("Enter", { timeout: 3_000 });
      }
      await expect(setOptions).toHaveAttribute("open", "", {
        timeout: 3_000,
      });
      await action();
    }).toPass({ timeout: 20_000 });
  };
  const selectSetOption = async (option: Locator) => {
    await withSetOptionsOpen(async () => {
      if ((await option.getAttribute("aria-pressed")) !== "true") {
        await option.focus({ timeout: 3_000 });
        await option.press("Enter", { timeout: 3_000 });
      }
      await expect(option).toHaveAttribute("aria-pressed", "true", {
        timeout: 3_000,
      });
    });
  };
  const rir = setOptions.getByLabel("RIR (0–10)");
  // Use DOM-state locators so preservation remains inspectable while the
  // replacement drawer correctly makes the background card inaccessible.
  const technique = setOptions
    .locator("button[aria-pressed]")
    .filter({ hasText: /^Bracing$/ });
  const limitation = setOptions
    .locator("button[aria-pressed]")
    .filter({ hasText: /^Grip$/ });
  await withSetOptionsOpen(async () => {
    await rir.fill("2", { timeout: 3_000 });
    await expect(rir).toHaveValue("2", { timeout: 3_000 });
  });
  await selectSetOption(technique);
  await selectSetOption(limitation);
  const recordPain = setOptions.getByRole("button", {
    name: "Record pain",
    exact: true,
  });
  await withSetOptionsOpen(async () => {
    await recordPain.focus({ timeout: 3_000 });
    await recordPain.press("Enter", { timeout: 3_000 });
    await expect(recordPain).toHaveCount(0, { timeout: 3_000 });
  });
  const knee = setOptions
    .locator("button[aria-pressed]")
    .filter({ hasText: /^knee$/ });
  const painSeverity = setOptions.locator(
    'button[aria-label="Pain severity 3"]',
  );
  const painNote = setOptions.getByLabel("Pain note (optional)");
  const setNote = setOptions.getByLabel("Set note (optional)");
  await selectSetOption(knee);
  await selectSetOption(painSeverity);
  await withSetOptionsOpen(async () => {
    await painNote.fill("Front of knee felt tight", { timeout: 3_000 });
    await expect(painNote).toHaveValue("Front of knee felt tight", {
      timeout: 3_000,
    });
  });
  await withSetOptionsOpen(async () => {
    await setNote.fill("Keep torso tall", { timeout: 3_000 });
    await expect(setNote).toHaveValue("Keep torso tall", {
      timeout: 3_000,
    });
  });

  const expectDraftPreserved = async () => {
    await expect(card).toHaveAttribute("data-draft-identity", draftIdentity!);
    await expect(weight).toHaveValue("77");
    await expect(reps).toHaveValue("9");
    await expect(rir).toHaveValue("2");
    await expect(technique).toHaveAttribute("aria-pressed", "true");
    await expect(limitation).toHaveAttribute("aria-pressed", "true");
    await expect(knee).toHaveAttribute("aria-pressed", "true");
    await expect(painSeverity).toHaveAttribute("aria-pressed", "true");
    await expect(painNote).toHaveValue("Front of knee felt tight");
    await expect(setNote).toHaveValue("Keep torso tall");
  };

  await expectDraftPreserved();
  if ((await setOptions.getAttribute("open")) != null) {
    await setOptionsSummary.focus();
    await setOptionsSummary.press("Enter");
    await expect(setOptions).not.toHaveAttribute("open", "");
  }

  const moreForExercise = card.locator("details", {
    hasText: "More for this exercise",
  });
  await moreForExercise.locator(":scope > summary").click();
  await expect(moreForExercise).toHaveAttribute("open", "");
  const replaceTrigger = card.getByRole("button", {
    name: "Replace exercise",
    exact: true,
  });
  await replaceTrigger.click();
  const drawer = page.getByRole("dialog", {
    name: "Replace exercise for this workout",
  });
  const catalogTrigger = drawer.getByRole("button", {
    name: "Search exercise catalog",
    exact: true,
  });
  await catalogTrigger.click();
  let picker = page.getByRole("dialog", {
    name: "Replace exercise",
    exact: true,
  });
  const search = picker.getByLabel("Search exercise library");
  await expect(search).not.toBeFocused();
  await expect(picker.getByText(/variants in \d+ families/)).toBeVisible();

  const filterToggle = picker.getByRole("button", {
    name: /^Filters/,
  });
  await filterToggle.click();
  await expect(picker.getByRole("group", { name: "Equipment" })).toBeVisible();
  await search.click();
  await search.fill("Dumbbell Curl");
  const immediateMatch = picker.getByRole("button", {
    name: "View details for Dumbbell Curl",
    exact: true,
  });
  await expect(picker.getByRole("group", { name: "Equipment" })).toHaveCount(0);
  await expect(immediateMatch).toBeVisible();
  await expect(immediateMatch).toBeInViewport();
  await search.fill("");
  await expect(search).toBeFocused();
  await expect(filterToggle).toHaveAttribute("aria-expanded", "false");

  const initialViewport = page.viewportSize();
  if (!initialViewport) {
    throw new Error("The replacement keyboard test requires a fixed viewport.");
  }
  for (const width of [320, 375, 390, 440]) {
    await page.setViewportSize({ width, height: 420 });
    await expect(search).toBeFocused();
    await expect
      .poll(async () => {
        const rect = await picker.boundingBox();
        return rect == null
          ? null
          : {
              top: Math.round(rect.y),
              bottom: Math.round(rect.y + rect.height),
            };
      })
      .toEqual({ top: 8, bottom: 412 });
    await expectKeyboardGeometry(page, picker);
  }
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error("visualViewport is unavailable");
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 220,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => {
      const rect = await picker.boundingBox();
      return rect == null
        ? null
        : {
            top: Math.round(rect.y),
            bottom: Math.round(rect.y + rect.height),
          };
    })
    .toEqual({ top: 8, bottom: 212 });
  await expectKeyboardGeometry(page, picker);
  await page.evaluate(() => {
    if (!window.visualViewport) throw new Error("visualViewport is unavailable");
    if (!Reflect.deleteProperty(window.visualViewport, "height")) {
      throw new Error("The simulated visualViewport height could not be restored.");
    }
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await page.setViewportSize(initialViewport);
  await expect
    .poll(() => page.evaluate(
      () => Math.round(window.visualViewport?.height ?? 0),
    ))
    .toBe(initialViewport.height);
  await expect(search).toBeFocused();
  await expectKeyboardGeometry(page, picker);

  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(catalogTrigger).toBeFocused();
  await expectDraftPreserved();

  await catalogTrigger.click();
  picker = page.getByRole("dialog", { name: "Replace exercise", exact: true });
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(catalogTrigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(replaceTrigger).toBeFocused();
  await expectDraftPreserved();

  await replaceTrigger.click();
  const reopenedDrawer = page.getByRole("dialog", {
    name: "Replace exercise for this workout",
  });
  await reopenedDrawer
    .getByRole("button", { name: "Search exercise catalog", exact: true })
    .click();
  picker = page.getByRole("dialog", { name: "Replace exercise", exact: true });
  await picker
    .getByRole("button", { name: "All exercises", exact: true })
    .click();
  await inspectSearchResult(picker, "Jump Rope");
  await expect(picker.getByText("Reps", { exact: true })).toBeVisible();
  await expect(
    picker.getByRole("button", {
      name: "Replace in this workout",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    picker.getByText("This variant cannot be selected here.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    picker.getByText(
      "This workout runner does not yet support this exercise type truthfully.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await returnToSearchResults(picker);

  await inspectSearchResult(picker, "Cable Face Pull");
  await expect(picker).toContainText("Required equipment is unavailable");
  await returnToSearchResults(picker);

  await inspectSearchResult(picker, "Bodyweight Bulgarian Split Squat");
  await expect(picker).toContainText("Reps");
  await expect(picker).toContainText("Bodyweight");
  const confirm = picker.getByRole("button", {
    name: "Replace in this workout",
    exact: true,
  });
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeVisible();

  let rejectOnce = true;
  await page.route("**/session/**", async (route) => {
    if (
      rejectOnce &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      rejectOnce = false;
      expectedRejectedRequest = true;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Disposable bodyweight replacement rejection",
      });
      return;
    }
    await route.continue();
  });
  await confirm.click();
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("heading", {
      name: "Bodyweight Bulgarian Split Squat",
    }),
  ).toBeVisible();
  await expect(confirm).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await expect(preparation).toContainText(originalExerciseName);

  await confirm.click();
  await expect(picker).toHaveCount(0);
  await expect(reopenedDrawer).toHaveCount(0);
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(
    "Bodyweight Bulgarian Split Squat",
  );
  await expect(preparation).not.toContainText(originalExerciseName);
  await expect(preparation).not.toContainText(
    "Updating equipment after workout change.",
  );
  await expect(card).toContainText("Reason: Variety");
  await expect(card).not.toContainText("Last time:");
  await expect(weight).toHaveCount(0);
  await expect(reps).toHaveValue("10");
  const logSet = card.getByRole("button", { name: "Log set", exact: true });
  await waitForHydratedReactHandler(logSet);
  await waitForHydratedReactChangeHandler(reps);
  await reps.fill("9");
  await expect(reps).toHaveValue("9");
  await logSet.click();
  await expect(card).toContainText("9 reps");
  await expect(card).not.toContainText("0 lb");

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return 0;
          const parsed = JSON.parse(raw) as { entries?: unknown[] };
          return parsed.entries?.length ?? 0;
        }),
      { timeout: 45_000 },
    )
    .toBe(0);

  await page.reload();
  await expect(page.getByTestId("current-exercise-card")).toContainText(
    "Bodyweight Bulgarian Split Squat",
  );
  await expect(page.getByTestId("current-exercise-card")).toContainText(
    "9 reps",
  );
  await expect(page.getByTestId("current-exercise-card")).not.toContainText(
    "Last time:",
  );
  await expect(page.getByText("Old implement and plate details are withheld.")).toHaveCount(0);
  await expect(page.getByTestId("session-preparation-panel")).toHaveCount(0);
  expectedRejectedRequest = false;
  await nextRscPrefetches.settle();
  expect(
    unexpectedErrors.filter(
      (message) =>
        !isExpectedWebKitRscLinkCancellation(
          message,
          browserName,
          EXPECTED_APP_SHELL_PREFETCHES,
        ) &&
        !isCorrelatedWebKitRscPrefetchCancellation(
          message,
          browserName,
          nextRscPrefetches.observedUrls,
        ),
    ),
  ).toEqual([]);
  await page.goto("/today");
  await discardActiveWorkout(page);
});
