import { expect, test, type Locator, type Page } from "@playwright/test";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_WARMUP } from "../fixtures/production-workout-start-contract";
import {
  installNextDevelopmentRefreshControl,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

async function signInAndStartDayA(
  page: Page,
  options: {
    extraLarge?: boolean;
    textSize?: "Compact" | "Default" | "Large" | "Extra large";
  } = {},
) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  const requestedTextSize = options.textSize ??
    (options.extraLarge === false ? "Default" : "Extra large");
  const fontSize = page.getByRole("radio", {
    name: new RegExp(`^${requestedTextSize}`),
  });
  await waitForHydratedReactHandler(fontSize);
  await fontSize.click();
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize),
  ).toBe(requestedTextSize.toLowerCase().replace(" ", "-"));

  await page.goto("/today");
  const start = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await waitForEquipmentSelectionsToSettle(page);
}

async function completeWarmupsToFirstWorkingSet(page: Page) {
  for (
    let warmupIndex = 0;
    warmupIndex < PRODUCTION_WORKOUT_START_WARMUP.length;
    warmupIndex += 1
  ) {
    const currentWarmup = warmupIndex === 0
      ? page.locator(
          '#workout-warmup [role="checkbox"][aria-checked="false"]:visible',
        ).first()
      : page.getByTestId("active-workout-dock-primary");
    await expect
      .poll(() => currentWarmup.getAttribute("aria-label"))
      .toContain(PRODUCTION_WORKOUT_START_WARMUP[warmupIndex].label);
    await waitForHydratedReactHandler(currentWarmup);
    await currentWarmup.click();
  }
  await expect(page.getByTestId("active-workout-dock-primary")).toHaveAttribute(
    "aria-label",
    /Log Barbell Back Squat, Set 1/i,
  );
}

async function expectReachableTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(async (element) => {
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const reachable =
      hit === element || (hit != null && element.contains(hit));
    return reachable ? "ok" : JSON.stringify({
      target:
        element.getAttribute("aria-label") ??
        element.getAttribute("data-testid") ??
        element.textContent?.trim().slice(0, 80) ??
        element.tagName,
      rect: {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
      },
      hit:
        hit instanceof HTMLElement
          ? hit.getAttribute("aria-label") ??
            hit.getAttribute("data-testid") ??
            hit.textContent?.trim().slice(0, 80) ??
            hit.tagName
          : null,
    });
  })).toBe("ok");
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  });
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.width).toBeGreaterThanOrEqual(44);
}

async function expectPrimaryActionUnobstructed(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const visualBottom = top + (viewport?.height ?? window.innerHeight);
    const ownsViewport =
      element.closest('[aria-label="Workout status"]') != null ||
      element.closest('[role="dialog"]') != null;
    const bottom = ownsViewport
      ? visualBottom
      : Math.min(
          visualBottom,
          dock?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
        );
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    const result = {
      viewportWidth: window.innerWidth,
      aboveViewportTop: rect.top >= top,
      aboveObstruction: rect.bottom <= bottom,
      horizontallyContained: rect.left >= 0 && rect.right <= window.innerWidth,
      hitTestable:
        hit === element || (hit != null && element.contains(hit)),
      rect: {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      },
      bottomBoundary: Math.round(bottom),
      scrollY: Math.round(window.scrollY),
      maxScroll: Math.round(
        document.documentElement.scrollHeight - window.innerHeight,
      ),
      actionIdentity:
        element.getAttribute("aria-label") ??
        element.getAttribute("data-testid") ??
        element.textContent?.trim().slice(0, 80) ??
        element.tagName,
      hitIdentity:
        hit?.getAttribute("aria-label") ??
        hit?.getAttribute("data-testid") ??
        hit?.textContent?.trim().slice(0, 80) ??
        hit?.tagName ??
        null,
      parentClass: element.parentElement?.className ?? null,
      finishRect: (() => {
        const finish = document.querySelector<HTMLElement>(
          '[aria-label="Review workout finish"], [aria-label="Finish workout"]',
        );
        const bounds = finish?.getBoundingClientRect();
        return bounds == null
          ? null
          : { top: Math.round(bounds.top), bottom: Math.round(bounds.bottom) };
      })(),
    };
    return result.aboveViewportTop && result.aboveObstruction &&
      result.horizontallyContained && result.hitTestable
      ? "ok"
      : JSON.stringify(result);
  })).toBe("ok");
}

for (const initialCase of [
  { width: 390, height: 844, textSize: "Compact" as const },
  { width: 390, height: 844, textSize: "Default" as const },
  { width: 390, height: 844, textSize: "Large" as const },
  { width: 390, height: 844, textSize: "Extra large" as const },
  { width: 320, height: 700, textSize: "Extra large" as const },
  { width: 440, height: 956, textSize: "Default" as const },
]) {
  test(`keeps the first action unobstructed at ${initialCase.width}x${initialCase.height} ${initialCase.textSize}`, async ({
    browserName,
    page,
  }, testInfo) => {
    const pageErrors = observeGauntletPageErrors(page, browserName);
    await page.setViewportSize({
      width: initialCase.width,
      height: initialCase.height,
    });
    try {
      await signInAndStartDayA(page, { textSize: initialCase.textSize });
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const action = page.locator(
        '#workout-warmup [role="checkbox"][aria-checked="false"]',
      ).first();
      await expectPrimaryActionUnobstructed(action);
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      )).toBeLessThanOrEqual(1);
      await testInfo.attach(
        `initial-${initialCase.width}x${initialCase.height}-${initialCase.textSize.toLowerCase().replace(" ", "-")}`,
        { body: await page.screenshot(), contentType: "image/png" },
      );
    } finally {
      await discardWorkout(page);
    }
    await pageErrors.expectNoUnexpected();
  });
}

test.describe("reduced-motion active workout", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("keeps automatic action handoffs instant and unobstructed", async ({
    browserName,
    page,
  }) => {
    const pageErrors = observeGauntletPageErrors(page, browserName);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const calls: Array<{ method: string; behavior: string | null }> = [];
      Object.defineProperty(window, "__activeWorkoutMotionCalls", {
        configurable: true,
        value: calls,
      });
      const originalScrollBy = window.scrollBy.bind(window);
      window.scrollBy = ((
        optionsOrX?: ScrollToOptions | number,
        y?: number,
      ) => {
        calls.push({
          method: "scrollBy",
          behavior:
            typeof optionsOrX === "object" && optionsOrX != null
              ? (optionsOrX.behavior ?? null)
              : null,
        });
        if (typeof optionsOrX === "number") {
          originalScrollBy(optionsOrX, y ?? 0);
        } else {
          originalScrollBy(optionsOrX);
        }
      }) as typeof window.scrollBy;
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function scrollIntoView(
        options?: boolean | ScrollIntoViewOptions,
      ) {
        calls.push({
          method: "scrollIntoView",
          behavior:
            typeof options === "object" && options != null
              ? (options.behavior ?? null)
              : null,
        });
        originalScrollIntoView.call(this, options);
      };
    });

    try {
      await signInAndStartDayA(page, { textSize: "Extra large" });
      await completeWarmupsToFirstWorkingSet(page);

      const firstWorkingSetAction = page.getByTestId(
        "active-workout-dock-primary",
      );
      await expect(firstWorkingSetAction).toHaveAttribute(
        "aria-label",
        /Log Barbell Back Squat, Set 1/i,
      );
      await expectPrimaryActionUnobstructed(firstWorkingSetAction);

      await page.getByRole("button", {
        name: "Review workout finish",
        exact: true,
      }).click();
      await page.getByRole("button", {
        name: "Back to workout",
        exact: true,
      }).click();
      await expectPrimaryActionUnobstructed(firstWorkingSetAction);

      const motionCalls = await page.evaluate(() =>
        (window as typeof window & {
          __activeWorkoutMotionCalls?: Array<{
            method: string;
            behavior: string | null;
          }>;
        }).__activeWorkoutMotionCalls ?? []
      );
      // A fully unobstructed handoff may not need to scroll at all. When a
      // reveal is needed, reduced motion must still keep every call instant.
      expect(motionCalls).not.toContainEqual(
        expect.objectContaining({ behavior: "smooth" }),
      );
    } finally {
      await discardWorkout(page);
    }
    await pageErrors.expectNoUnexpected();
  });
});

test("keeps attention continuous through warm-up, first set, and exact recovery without an assisted scroll", async ({
  browserName,
  context,
  page,
}, testInfo) => {
  const pageErrors = observeGauntletPageErrors(page, browserName, [
    /Failed to fetch/i,
    /Load failed/i,
    /ERR_(?:FAILED|INTERNET_DISCONNECTED)/i,
    /NetworkError when attempting to fetch resource/i,
  ]);
  const sizes = ["Extra large"] as const;
  for (const textSize of sizes) {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await signInAndStartDayA(page, { textSize });
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const action = page.locator(
        '#workout-warmup [role="checkbox"][aria-checked="false"]',
      ).first();
      await expectPrimaryActionUnobstructed(action);
      await testInfo.attach(`initial-${textSize.toLowerCase().replace(" ", "-")}-390x844`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      if (textSize === "Extra large") {
        for (
          let warmupIndex = 0;
          warmupIndex < PRODUCTION_WORKOUT_START_WARMUP.length;
          warmupIndex += 1
        ) {
          const currentWarmup = warmupIndex === 0
            ? page.locator(
                '#workout-warmup [role="checkbox"][aria-checked="false"]:visible',
              ).first()
            : page.getByTestId("active-workout-dock-primary");
          await expect
            .poll(() => currentWarmup.getAttribute("aria-label"))
            .toContain(PRODUCTION_WORKOUT_START_WARMUP[warmupIndex].label);
          await waitForHydratedReactHandler(currentWarmup);
          await currentWarmup.click();
          if (warmupIndex < PRODUCTION_WORKOUT_START_WARMUP.length - 1) {
            await expectPrimaryActionUnobstructed(
              page.getByTestId("active-workout-dock-primary"),
            );
          }
        }
        const firstWorkingSetAction = page.getByTestId(
          "active-workout-dock-primary",
        );
        await expect(firstWorkingSetAction).toHaveAttribute(
          "aria-label",
          /Log Barbell Back Squat, Set 1/i,
        );
        await waitForHydratedReactHandler(firstWorkingSetAction);
        await expectPrimaryActionUnobstructed(firstWorkingSetAction);
        await testInfo.attach("first-working-set-extra-large-390x844", {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        await context.setOffline(true);
        await firstWorkingSetAction.evaluate((element) => {
          element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await expect(firstWorkingSetAction).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return 0;
          return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
        })).toBe(1);
        await expect(
          page.getByText(/already waiting to be saved/i),
        ).toHaveCount(0);
        await page.evaluate(() => {
          const storageKey = "workout-tracker:workout-set-outbox:v1";
          const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
            entries: Array<{
              occurrenceId?: string;
              expectedOccurrenceRevision?: number;
              sessionExerciseId: string;
              exerciseName: string;
              setNo: number;
              status: string;
              attemptCount: number;
              nextAttemptAtISO: string | null;
              lastAttemptAtISO: string | null;
              lastError: string | null;
              orderBlocker?: unknown;
            }>;
          } | null;
          const entry = stored?.entries[0];
          if (!stored || !entry?.occurrenceId) {
            throw new Error("The synthetic retained set is missing its exact occurrence.");
          }
          const blockerOccurrenceId = entry.occurrenceId;
          entry.occurrenceId = crypto.randomUUID();
          entry.setNo = 2;
          entry.status = "needs_attention";
          entry.attemptCount = 1;
          entry.nextAttemptAtISO = null;
          entry.lastAttemptAtISO = new Date().toISOString();
          entry.lastError = `Resolve ${entry.exerciseName} · Set 1 first.`;
          entry.orderBlocker = {
            occurrenceId: blockerOccurrenceId,
            occurrenceRevision: entry.expectedOccurrenceRevision ?? 0,
            sessionExerciseId: entry.sessionExerciseId,
            exerciseName: entry.exerciseName,
            setNo: 1,
            groupRound: null,
            origin: "planned",
            isAddedSet: false,
            label: `${entry.exerciseName} · Set 1`,
          };
          sessionStorage.setItem(
            "gauntlet:retained-set",
            JSON.stringify(entry),
          );
          stored.entries = [];
          localStorage.setItem(storageKey, JSON.stringify(stored));
          window.dispatchEvent(new Event("workout-set-outbox-change"));
        });
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return 0;
          return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
        })).toBe(0);
        await context.setOffline(false);
        await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
        await page.evaluate(() => {
          const storageKey = "workout-tracker:workout-set-outbox:v1";
          const retained = sessionStorage.getItem("gauntlet:retained-set");
          const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
            entries: unknown[];
          } | null;
          if (!stored || !retained) {
            throw new Error("The synthetic retained-set fixture was lost.");
          }
          stored.entries = [JSON.parse(retained)];
          localStorage.setItem(storageKey, JSON.stringify(stored));
          sessionStorage.removeItem("gauntlet:retained-set");
          window.dispatchEvent(new Event("workout-set-outbox-change"));
        });
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return null;
          const entry = (JSON.parse(raw) as {
            entries?: Array<{ status?: string; orderBlocker?: unknown }>;
          }).entries?.[0];
          return entry?.status === "needs_attention" && entry.orderBlocker != null;
        })).toBe(true);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return null;
          const entry = (JSON.parse(raw) as {
            entries?: Array<{ status?: string; orderBlocker?: unknown }>;
          }).entries?.[0];
          return entry?.status === "needs_attention" && entry.orderBlocker != null;
        })).toBe(true);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("workout-set-outbox-change"));
        });

        const recoveryStatus = page.getByRole("button", {
          name: "Open sets waiting to save",
          exact: true,
        });
        await expect(recoveryStatus).toContainText("Sets need attention");
        await expectPrimaryActionUnobstructed(recoveryStatus);
        await recoveryStatus.click();
        const goToBlocker = page.getByRole("link", {
          name: /Go to required Barbell Back Squat · Set 1/i,
        });
        await expectPrimaryActionUnobstructed(goToBlocker);
        await expect(
          page.getByRole("button", { name: "Retry save", exact: true }),
        ).toHaveCount(0);
        await goToBlocker.click();
        await expect(
          page.getByRole("dialog", { name: "Sets waiting to save" }),
        ).toHaveCount(0);
        const blockerEntry = page.getByTestId("current-set-entry");
        await expect.poll(() => blockerEntry.evaluate((element) => {
          const active = document.activeElement as HTMLElement | null;
          const rect = element.getBoundingClientRect();
          return {
            inside: active != null && element.contains(active),
            expanded:
              element.closest("section")?.querySelector(
                '[data-testid="exercise-swipe-surface"]',
              )
                ?.getAttribute("aria-expanded") === "true",
            active:
              active?.getAttribute("aria-label") ??
              active?.textContent?.trim().slice(0, 80) ??
              active?.tagName ??
              "none",
            hash: window.location.hash,
            targetId: element.id,
            targetTop: Math.round(rect.top),
            targetBottom: Math.round(rect.bottom),
          };
        })).toMatchObject({
          inside: true,
          expanded: true,
          hash: `#${await blockerEntry.getAttribute("id")}`,
        });
        await testInfo.attach("order-blocker-recovery-extra-large-390x844", {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        const blockerLog = blockerEntry.getByRole("button", {
          name: "Log set",
          exact: true,
        });
        await expect(blockerLog).toBeEnabled();
        await expectPrimaryActionUnobstructed(blockerLog);
        await blockerLog.click();
        await expect(page.getByTestId("set-save-announcement")).toContainText(
          "set 1 saved",
        );
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return null;
          const entry = (JSON.parse(raw) as {
            entries?: Array<{
              status?: string;
              orderBlocker?: unknown;
            }>;
          }).entries?.[0];
          return entry?.status === "needs_attention" &&
              entry.orderBlocker == null
            ? "released-once"
            : null;
        })).toBe("released-once");

        await recoveryStatus.click();
        await page.getByRole("button", {
          name: "Discard device copy",
          exact: true,
        }).click();
        await page.getByRole("button", {
          name: "Discard device copy",
          exact: true,
        }).click();
        await expect.poll(() => page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:workout-set-outbox:v1",
          );
          if (!raw) return 0;
          return (JSON.parse(raw) as { entries?: unknown[] }).entries?.length ?? 0;
        })).toBe(0);
      }
    } finally {
      await discardWorkout(page);
    }
  }

  await pageErrors.expectNoUnexpected();
});

async function revealCurrentFromStatusBar(page: Page) {
  const workoutStatus = page.getByRole("complementary", {
    name: "Workout status",
  });
  const reveal = workoutStatus.locator("button").first();
  await waitForHydratedReactHandler(reveal);
  await expectReachableTarget(reveal);
  const label = await reveal.getAttribute("aria-label");
  if (label?.startsWith("Show ")) {
    await reveal.click();
  } else {
    expect(label).toMatch(/^Log /);
    await expectPrimaryActionUnobstructed(reveal);
    await expectReachableTarget(page.getByTestId("active-log-set"));
  }
  await expect.poll(() => page.evaluate(() => {
    const log = document.querySelector<HTMLElement>(
      '[data-testid="active-log-set"]',
    );
    const dock = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    if (!log || !dock) return false;
    return log.getBoundingClientRect().bottom <=
      dock.getBoundingClientRect().top - 8;
  })).toBe(true);
}

async function compactGeometry(page: Page) {
  return page.evaluate(() => {
    const primaryElement = document.querySelector<HTMLElement>(
      '[data-testid="active-workout-primary"]',
    );
    const previousElement = document.querySelector<HTMLElement>(
      '[data-testid="previous-comparable-set"]',
    );
    const targetElement = document.querySelector<HTMLElement>(
      '[data-testid="current-set-target"]',
    );
    const logElement = document.querySelector<HTMLElement>(
      '[data-testid="active-log-set"]',
    );
    const dockElement = document.querySelector<HTMLElement>(
      '[aria-label="Workout status"]',
    );
    const cardElement = document.querySelector<HTMLElement>(
      '[data-testid="current-exercise-card"]',
    );
    if (!primaryElement || !targetElement || !previousElement || !logElement || !dockElement || !cardElement) {
      throw new Error("The compact active-workout geometry is incomplete.");
    }
    const primaryRect = primaryElement.getBoundingClientRect();
    const previousRect = previousElement.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const firstInput = primaryElement.querySelector<HTMLElement>("input");
    const inputWidths = [...primaryElement.querySelectorAll<HTMLElement>("input")]
      .map((input) => input.getBoundingClientRect().width);
    const logRect = logElement.getBoundingClientRect();
    return {
      primaryHeight: primaryRect.height,
      cardHeight: cardElement.getBoundingClientRect().height,
      targetBeforePrevious: targetRect.bottom <= previousRect.top,
      targetBeforeOrBesidePrevious:
        targetRect.bottom <= previousRect.top ||
        (Math.abs(targetRect.top - previousRect.top) <= 2 &&
          targetRect.right <= previousRect.left),
      previousBeforeInput:
        firstInput != null && previousRect.bottom <= firstInput.getBoundingClientRect().top,
      evidenceBeforeInput:
        firstInput != null &&
        Math.max(targetRect.bottom, previousRect.bottom) <=
          firstInput.getBoundingClientRect().top,
      inputBeforeLog:
        firstInput != null && firstInput.getBoundingClientRect().bottom <= logRect.top,
      logClearsDock: logRect.bottom <= dockElement.getBoundingClientRect().top - 8,
      logBottom: logRect.bottom,
      dockTop: dockElement.getBoundingClientRect().top,
      primaryTop: primaryRect.top,
      primaryBottom: primaryRect.bottom,
      minimumInputWidth:
        inputWidths.length > 0 ? Math.min(...inputWidths) : 0,
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      cardChildren: [...cardElement.children].map((child) => ({
        tag: child.tagName,
        height: child.getBoundingClientRect().height,
      })),
      disclosures: [...cardElement.querySelectorAll("details")].map(
        (details) => ({
          summary: details.querySelector("summary")?.textContent?.trim() ?? "",
          summaryHeight:
            details.querySelector("summary")?.getBoundingClientRect().height ?? 0,
          open: details.open,
          height: details.getBoundingClientRect().height,
        }),
      ),
    };
  });
}

async function discardWorkout(page: Page) {
  if (page.isClosed()) return;
  if (!/\/session\/[0-9a-f-]+(?:#.*)?$/.test(page.url())) return;
  try {
    await page.context().setOffline(false);
  } catch {
    return;
  }
  const todayUrl = new URL("/today", page.url()).href;
  await page.evaluate(() => {
    localStorage.removeItem("workout-tracker:workout-set-outbox:v1");
    window.dispatchEvent(new Event("workout-set-outbox-change"));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const finishDialog = page.getByRole("dialog", { name: "Finish workout" });
  if (!(await finishDialog.isVisible())) {
    const finish = page.getByRole("button", {
      name: /^(?:Review workout finish|Finish workout)$/,
    });
    await waitForHydratedReactHandler(finish);
    await finish.click();
  }
  const discard = finishDialog.getByRole("button", {
    name: "Discard workout",
    exact: true,
  });
  await waitForHydratedReactHandler(discard);
  await discard.click();
  const confirm = page
    .getByRole("dialog", { name: /^Discard .+\?$/ })
    .getByRole("button", {
      name: /^(?:Confirm discard|Discard current device copies & abandon)$/,
    });
  await waitForHydratedReactHandler(confirm);
  await confirm.click();
  await expect.poll(async () =>
    /\/today$/.test(page.url()) ||
    await page.getByText("Workout recovery", { exact: true }).isVisible()
  ).toBe(true);
  if (!/\/today$/.test(page.url())) {
    await page.goto(todayUrl, { waitUntil: "domcontentloaded" });
  }
  await expect(page).toHaveURL(/\/today$/);
}

test("keeps the ordinary active set current-first, unobstructed, and acknowledgement-truthful", async ({
  browserName,
  page,
}) => {
  const pageErrors = observeGauntletPageErrors(page, browserName);
  try {
    await signInAndStartDayA(page);
    await completeWarmupsToFirstWorkingSet(page);

    const currentCard = page.getByTestId("current-exercise-card");
    const currentEntry = currentCard.getByTestId("current-set-entry");
    await expect(currentEntry).toBeVisible();
    await expect(currentEntry).toContainText("Current action");
    await expect(currentEntry).toContainText("Set 1 of 3");
    await expect(currentEntry).toContainText("Performed measure");
    await expect(currentEntry).toContainText("Next action");
    await expect(currentEntry).toContainText("Barbell Back Squat, set 2");

    const setOptions = currentEntry.locator("details", {
      hasText: "Set options",
    });
    await expect(setOptions).not.toHaveAttribute("open", "");
    await expect(
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "Workout progress and upcoming work" }),
    ).not.toContainText("Next:");

    const orderedVisibleActions = [
      currentEntry.getByText("Current action", { exact: true }),
      currentEntry.getByTestId("previous-comparable-set"),
      currentEntry.getByText("Performed measure", { exact: true }),
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
      currentEntry.getByText("Next action", { exact: true }),
      setOptions.locator(":scope > summary"),
    ];
    for (const action of orderedVisibleActions) await expect(action).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(async () => {
      const actionBounds = await Promise.all(
        orderedVisibleActions.map((action) => action.boundingBox()),
      );
      return actionBounds.every((bounds) => bounds !== null) &&
        actionBounds.slice(1).every(
          (bounds, index) => bounds!.y > actionBounds[index]!.y,
        );
    }).toBe(true);

    const primaryTargets = [
      currentEntry.getByLabel("Total load", { exact: true }),
      currentEntry.getByRole("textbox", { name: "Reps", exact: true }),
      currentEntry.getByRole("button", { name: "Log set", exact: true }),
      setOptions.locator("summary"),
    ];
    for (const target of primaryTargets) await expectReachableTarget(target);

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const logSet = currentEntry.getByRole("button", {
      name: "Log set",
      exact: true,
    });
    const currentEquipmentSetup = page
      .getByTestId("exercise-equipment-setup")
      .filter({ hasText: "Barbell Back Squat" });
    await expect(currentEquipmentSetup).toHaveAttribute("open", "");
    expect(await currentEquipmentSetup.evaluate((setup) => {
      const card = document.querySelector('[data-testid="current-exercise-card"]');
      return card != null && Boolean(
        setup.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    })).toBe(true);
    await logSet.click();
    await expect(page.getByTestId("set-save-announcement")).toContainText(
      "Barbell Back Squat, set 1 saved.",
    );
    await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
    const completedSets = currentCard.getByTestId("completed-sets");
    await expect(completedSets).not.toHaveAttribute("open", "");
    await expect(completedSets.locator(":scope > summary")).toContainText(
      "1 completed",
    );
    await expect(currentEquipmentSetup).not.toHaveAttribute("open", "");
    await expect(currentEntry).toContainText("Set 2 of 3");
    const restingGeometry = await compactGeometry(page);
    expect(
      restingGeometry,
      JSON.stringify(restingGeometry),
    ).toMatchObject({
      targetBeforeOrBesidePrevious: true,
      evidenceBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
    expect(restingGeometry.disclosures.every((item) => !item.open)).toBe(true);
    expect(
      restingGeometry.disclosures.every(
        (item) => item.height <= item.summaryHeight + 2,
      ),
      JSON.stringify(restingGeometry.disclosures),
    ).toBe(true);
    expect(restingGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
    await expect(setOptions.getByLabel("RIR (0–10)")).not.toBeVisible();
    await expect(setOptions.getByLabel("Set note (optional)")).not.toBeVisible();
    const workoutStatus = page.getByRole("complementary", {
      name: "Workout status",
    });
    const skipRest = workoutStatus.getByRole("button", {
      name: "Skip rest",
      exact: true,
    });
    await expectPrimaryActionUnobstructed(skipRest);
    await skipRest.click();
    const dismissRest = workoutStatus.getByRole("button", {
      name: "Dismiss rest timer",
      exact: true,
    });
    await expectPrimaryActionUnobstructed(dismissRest);
    await dismissRest.click();
    const setTwoDockAction = page.getByTestId("active-workout-dock-primary");
    await expect(setTwoDockAction).toHaveAttribute(
      "aria-label",
      /Log Barbell Back Squat, Set 2/i,
    );
    await expectPrimaryActionUnobstructed(setTwoDockAction);
    await expect(workoutStatus.getByRole("button", {
      name: "Skip rest",
      exact: true,
    })).toHaveCount(0);
    await expect(currentCard.getByTestId("exercise-swipe-surface")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const setTwoEntryId = await currentEntry.getAttribute("id");
    expect(setTwoEntryId).not.toBeNull();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
      `#${setTwoEntryId}`,
    );
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));
    await completedSets.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(completedSets).toHaveAttribute("open", "");
    await expect(
      completedSets.getByRole("button", { name: "Correct set", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(completedSets).not.toHaveAttribute("open", "");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const settledSetTwoGeometry = await compactGeometry(page);
    expect(
      settledSetTwoGeometry,
      JSON.stringify(settledSetTwoGeometry),
    ).toMatchObject({
      targetBeforeOrBesidePrevious: true,
      evidenceBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
  } finally {
    await discardWorkout(page);
  }
  await pageErrors.expectNoUnexpected();
});

test("fits the complete primary logging action at 390x844 with keyboard disclosures", async ({
  browserName,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors = observeGauntletPageErrors(page, browserName);
  try {
    await signInAndStartDayA(page, { extraLarge: false });
    await completeWarmupsToFirstWorkingSet(page);
    const currentCard = page.getByTestId("current-exercise-card");
    const currentEntry = currentCard.getByTestId("current-set-entry");
    const primary = currentEntry.getByTestId("active-workout-primary");
    const previous = primary.getByTestId("previous-comparable-set");
    const log = primary.getByRole("button", { name: "Log set", exact: true });

    await expect(previous).toBeVisible();
    let terminalComparison:
      | { state: "available"; href: string }
      | { state: "unavailable" }
      | null = null;
    await expect(async () => {
      const snapshot = await previous.evaluate((element) => {
        const sourceLinks = element.querySelectorAll<HTMLAnchorElement>(
          'a[aria-label="View source workout"]',
        );
        return {
          state: element.getAttribute("data-comparison-state"),
          text: element.textContent?.trim() ?? "",
          sourceCount: sourceLinks.length,
          href: sourceLinks[0]?.getAttribute("href") ?? null,
        };
      });
      if (snapshot.state === "available") {
        expect(snapshot.sourceCount).toBe(1);
        expect(snapshot.href).toMatch(/^\/history\/[0-9a-f-]+$/);
        terminalComparison = {
          state: "available",
          href: snapshot.href!,
        };
        return;
      }
      if (snapshot.state === "unavailable") {
        expect(snapshot.sourceCount).toBe(0);
        expect(snapshot.text).toBe("Previous comparable set unavailable");
        terminalComparison = { state: "unavailable" };
        return;
      }
      throw new Error("Previous comparable evidence is still loading.");
    }).toPass({ timeout: 25_000 });
    expect(terminalComparison).not.toBeNull();
    await expect(log).toBeVisible();
    await expect(currentEntry).toContainText("Current action");
    await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
    await expect(page.getByTestId("active-workout-dock-primary")).toHaveAttribute(
      "aria-label",
      /Log Barbell Back Squat, Set 1/i,
    );
    await revealCurrentFromStatusBar(page);
    await expect(currentEntry).toContainText("Current action");
    await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
    await expect(page.getByTestId("active-workout-dock-primary")).toHaveAttribute(
      "aria-label",
      /Log Barbell Back Squat, Set 1/i,
    );

    const geometry = await compactGeometry(page);
    expect(geometry, JSON.stringify(geometry)).toMatchObject({
      targetBeforePrevious: true,
      previousBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
    expect(geometry.primaryHeight).toBeLessThanOrEqual(560);
    expect(geometry.disclosures.every((item) => !item.open)).toBe(true);
    expect(
      geometry.disclosures.every(
        (item) => item.height <= item.summaryHeight + 2,
      ),
      JSON.stringify(geometry.disclosures),
    ).toBe(true);
    expect(geometry.minimumInputWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Log set", exact: true })).toHaveCount(1);

    const setOptions = currentEntry.locator("details", {
      hasText: "Set options",
    });
    const setOptionsSummary = setOptions.locator(":scope > summary");
    await setOptionsSummary.focus();
    await page.keyboard.press("Enter");
    await expect(setOptions).toHaveAttribute("open", "");
    await expect(setOptions.getByLabel("RIR (0–10)")).toBeVisible();
    await expect(
      setOptions.getByRole("button", { name: "Skip set", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(setOptions).not.toHaveAttribute("open", "");

    const progress = currentCard.locator("details", {
      hasText: "Completed sets",
    });
    const progressSummary = progress.locator(":scope > summary");
    await progressSummary.focus();
    await page.keyboard.press("Enter");
    await expect(progress).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(progress).not.toHaveAttribute("open", "");

    const more = currentCard.locator("details", {
      hasText: "More for this exercise",
    });
    const moreSummary = more.locator(":scope > summary");
    await moreSummary.focus();
    await page.keyboard.press("Enter");
    await expect(more).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(more).not.toHaveAttribute("open", "");

    await discardWorkout(page);
    await signInAndStartDayA(page, { extraLarge: true });
    await completeWarmupsToFirstWorkingSet(page);
    const extraLargeEntry = page.getByTestId("current-set-entry");
    await expect(extraLargeEntry).toContainText("Current action");
    await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
    await expect(page.getByTestId("active-workout-dock-primary")).toHaveAttribute(
      "aria-label",
      /Log Barbell Back Squat, Set 1/i,
    );
    await revealCurrentFromStatusBar(page);
    for (const target of [
      extraLargeEntry.getByTestId("current-set-target"),
      extraLargeEntry.getByTestId("previous-comparable-set"),
      extraLargeEntry.getByLabel("Total load", { exact: true }),
      extraLargeEntry.getByRole("textbox", { name: "Reps", exact: true }),
      extraLargeEntry.getByRole("button", { name: "Log set", exact: true }),
    ]) {
      await expectReachableTarget(target);
    }
    await expect(extraLargeEntry).toContainText("Current action");
    await expect(page.getByTestId("active-set-save-receipt")).toHaveCount(0);
    await expect(page.getByTestId("active-workout-dock-primary")).toHaveAttribute(
      "aria-label",
      /Log Barbell Back Squat, Set 1/i,
    );
    const extraLargeGeometry = await compactGeometry(page);
    expect(
      extraLargeGeometry,
      JSON.stringify(extraLargeGeometry),
    ).toMatchObject({
      targetBeforePrevious: true,
      previousBeforeInput: true,
      inputBeforeLog: true,
      logClearsDock: true,
    });
    expect(
      extraLargeGeometry.primaryHeight,
      JSON.stringify(extraLargeGeometry),
    ).toBeLessThanOrEqual(800);
    expect(extraLargeGeometry.disclosures.every((item) => !item.open)).toBe(true);
    expect(
      extraLargeGeometry.disclosures.every(
        (item) => item.height <= item.summaryHeight + 2,
      ),
      JSON.stringify(extraLargeGeometry.disclosures),
    ).toBe(true);
    expect(extraLargeGeometry.disclosures.map((item) => item.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Set options"),
        expect.stringContaining("Completed sets"),
        expect.stringContaining("Extra sets"),
        expect.stringContaining("More for this exercise"),
        expect.stringContaining("Warm-up guidance · reference"),
      ]),
    );
    expect(extraLargeGeometry.minimumInputWidth).toBeGreaterThanOrEqual(44);
    expect(extraLargeGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
  } finally {
    await discardWorkout(page);
  }
  await pageErrors.expectNoUnexpected();
});
