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

const EXPECTED_APP_SHELL_PREFETCHES = new Set(["/program"]);

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
  await page.getByRole("button", { name: "Finish", exact: true }).click();
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
  await waitForHydratedReactChangeHandler(search);
  await search.fill(name);
  const result = picker.getByRole("button", {
    name: `View details for ${name}`,
    exact: true,
  });
  await expect(result).toBeVisible();
  await result.click();
}

async function expectKeyboardGeometry(page: Page, picker: Locator) {
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
      .map((element) => element.dataset.testid ?? element.dataset.slot ?? element.tagName);
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
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.visibleBottom + 1);
  expect(geometry.dialog.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.dialog.right).toBeLessThanOrEqual(
    (await page.evaluate(() => document.documentElement.clientWidth)) + 1,
  );
  expect(geometry.focused).not.toBeNull();
  expect(geometry.focused?.top ?? -1).toBeGreaterThanOrEqual(
    geometry.visibleTop - 1,
  );
  expect(geometry.focused?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    geometry.visibleBottom + 1,
  );
  expect(geometry.scrollOwners).toEqual(["exercise-picker-scroll"]);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
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
  const weight = card.getByLabel(/^(Weight|Total load|Displayed load)/);
  const reps = card.getByLabel("Reps", { exact: true });
  await waitForHydratedReactChangeHandler(weight);
  await waitForHydratedReactChangeHandler(reps);
  await weight.fill("77");
  await reps.fill("9");
  await expect(weight).toHaveValue("77");
  await expect(reps).toHaveValue("9");

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
  await expect(search).toBeFocused();

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
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 420,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });

  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(catalogTrigger).toBeFocused();
  await expect(weight).toHaveValue("77");
  await expect(reps).toHaveValue("9");

  await catalogTrigger.click();
  picker = page.getByRole("dialog", { name: "Replace exercise", exact: true });
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(catalogTrigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(replaceTrigger).toBeFocused();

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
  await picker.getByRole("button", { name: "Back", exact: true }).click();

  await inspectSearchResult(picker, "Cable Face Pull");
  await expect(picker).toContainText("Required equipment is unavailable");
  await picker.getByRole("button", { name: "Back", exact: true }).click();

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

  await confirm.click();
  await expect(picker).toHaveCount(0);
  await expect(reopenedDrawer).toHaveCount(0);
  await expect(card.getByRole("heading", { level: 2 })).toHaveText(
    "Bodyweight Bulgarian Split Squat",
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
