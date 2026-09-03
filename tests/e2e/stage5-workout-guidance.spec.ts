import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  openNativeDetails,
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const runId =
  process.env.STAGE5_RUN_ID ?? "remediation-2026-07-22-stage5-r16";
const evidenceDirectory = resolve("output/playwright", runId, "evidence");
const captureEvidence = process.env.STAGE5_CAPTURE_EVIDENCE === "1";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (captureEvidence) await mkdir(evidenceDirectory, { recursive: true });
});

async function screenshot(page: Page, name: string) {
  if (!captureEvidence) return;
  await page.screenshot({
    path: resolve(evidenceDirectory, name),
    fullPage: false,
  });
}

async function locatorScreenshot(locator: Locator, name: string) {
  if (!captureEvidence) return;
  await locator.screenshot({ path: resolve(evidenceDirectory, name) });
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

async function startProgramDay(
  page: Page,
  dayName: string,
  settleEquipment = true,
) {
  const primaryHeading = page.getByRole("heading", {
    name: dayName,
    exact: true,
  });
  if ((await primaryHeading.count()) > 0) {
    const start = page.getByRole("button", {
      name: "Train as planned",
      exact: true,
    });
    await waitForHydratedServerAction(start);
    await start.click();
  } else {
    const alternatives = page.getByTestId("alternate-program-days");
    await alternatives.locator("summary").click();
    const preview = alternatives.getByRole("button", {
      name: new RegExp(dayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    await preview.click();
    const start = page.getByRole("button", { name: "Start workout", exact: true });
    await waitForHydratedServerAction(start);
    await start.click();
  }
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: dayName, exact: true }),
  ).toBeVisible();
  if (settleEquipment) {
    await waitForEquipmentSelectionsToSettle(page);
  }
}

async function skipCurrentSet(dock: Locator) {
  const page = dock.page();
  const progress = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  const before = await progress.textContent();
  const currentCard = page.getByTestId("current-exercise-card");
  const skipSet = currentCard.getByRole("button", {
    name: "Skip set",
    exact: true,
  });
  if (!(await skipSet.isVisible())) {
    await openNativeDetails(currentCard.getByTestId("active-exercise-details"));
  }
  await expect(skipSet).toBeVisible();
  await waitForScrollToSettle(page);
  await skipSet.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await waitForScrollToSettle(page);
  await expect
    .poll(() =>
      skipSet.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return hit === element || (hit != null && element.contains(hit));
      }),
    )
    .toBe(true);
  await skipSet.click();
  const dialog = page.getByRole("dialog", { name: /^Skip set / });
  await dialog.getByLabel("Reason").selectOption("time_limit_reached");
  await dialog.getByRole("button", { name: "Skip item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => await progress.textContent())
    .not.toBe(before);
  await waitForSetSkippedNoticesToSettle(page);
  await waitForScrollToSettle(page);
}

async function waitForScrollToSettle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let settleTimer = window.setTimeout(finish, 150);
        function finish() {
          window.removeEventListener("scroll", onScroll);
          window.clearTimeout(settleTimer);
          resolve();
        }
        function onScroll() {
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(finish, 150);
        }
        window.addEventListener("scroll", onScroll, { passive: true });
      }),
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

function isExpectedOptimizedRequestCancellation(failure: string) {
  if (!failure.endsWith(" — net::ERR_ABORTED")) return false;
  return (
    /^POST http:\/\/[^/]+\/(?:sign-in|settings|today|session\/[0-9a-f-]+)(?:\?[^ ]*)? — /.test(
      failure,
    ) ||
    (/^GET http:\/\/[^/]+\//.test(failure) && failure.includes("_rsc="))
  );
}

async function waitForSetSkippedNoticesToSettle(page: Page) {
  await expect(page.getByText("Set skipped", { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function discardWorkout(page: Page) {
  await page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: /^(?:Review and finish workout|Finish workout)$/ })
    .click();
  const finish = page.getByRole("dialog", { name: "Finish workout" });
  await finish
    .getByRole("button", { name: "Discard workout", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: /^Discard .+\?$/ });
  await confirmation
    .getByRole("button", { name: "Confirm discard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
}

test("keeps Stage 5 guidance truthful, persistent, and usable on narrow mobile screens", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const metrics = { requests: 0, releases: 0 };
    Object.defineProperty(window, "__wakeLockTestMetrics", { value: metrics });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          metrics.requests += 1;
          const sentinel = new EventTarget() as EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          };
          sentinel.released = false;
          sentinel.release = async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            metrics.releases += 1;
            sentinel.dispatchEvent(new Event("release"));
          };
          return sentinel;
        },
      },
    });
  });
  const browserErrors: string[] = [];
  const requestFailures: string[] = [];
  const httpErrors: string[] = [];
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
    requestFailures.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await signIn(page);
  await page.goto("/settings");
  const defaultSound = page.getByRole("radio").filter({
    hasText: "Countdown ticks + finish alarm (default)",
  });
  await expect(defaultSound).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("button", { name: "Test selected cue", exact: true })
    .click();
  await expect(
    page.getByText(
      /The selected cue (?:was requested|was blocked by this browser|is unavailable in this browser)/,
    ),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Extra large/ }).click();
  await expect(
    page.getByText("Saved to your profile.", { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto("/today");
  await startProgramDay(page, "Day B — Hinge");

  const dock = page.getByTestId("current-exercise-card");
  const statusBar = page.getByRole("complementary", { name: "Workout status" });
  const guidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(guidance).toContainText("0/14");
  await expect(dock.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Romanian Deadlift, Set 1");
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await expect(dock).toContainText("Next action");
  await expect(dock).toContainText("Romanian Deadlift, set 2");

  let releaseSave!: () => void;
  const saveMayFinish = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveStarted = false;
  await page.route("**/session/**", async (route) => {
    const postData = route.request().postData() ?? "";
    if (
      !saveStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"] &&
      postData.includes('"setNo"')
    ) {
      saveStarted = true;
      await saveMayFinish;
    }
    await route.continue();
  });
  const firstLogSet = page.getByTestId("active-log-set");
  await waitForHydratedReactHandler(firstLogSet);
  await firstLogSet.click();
  await expect.poll(() => saveStarted).toBe(true);
  const deadliftCard = page.getByRole("region", {
    name: "Romanian Deadlift",
    exact: true,
  });
  await expect(deadliftCard).toContainText("saving");
  await expect(guidance).toContainText("0/14");
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await expect(statusBar.getByRole("region", { name: "Rest timer" }))
    .toContainText("Next: Romanian Deadlift, set 2");
  await expect(dock.getByTestId("current-set-entry")).toContainText("Set 2");
  await expect(page.getByTestId("active-log-set")).toHaveAccessibleName(
    "Log set 2",
  );
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wakeLockTestMetrics: { requests: number } })
      .__wakeLockTestMetrics.requests,
  )).toBe(1);
  const remainingBeforeDelay = await statusBar
    .getByLabel("Rest timer")
    .locator("span.tabular-nums")
    .first()
    .textContent();
  await page.waitForTimeout(2_000);
  await expect(statusBar.getByRole("region", { name: "Rest timer" }))
    .toContainText("Next: Romanian Deadlift, set 2");
  const remainingAfterDelay = await statusBar
    .getByLabel("Rest timer")
    .locator("span.tabular-nums")
    .first()
    .textContent();
  const timerSeconds = (value: string | null) => {
    const [minutes, seconds] = (value ?? "").split(":").map(Number);
    return minutes * 60 + seconds;
  };
  expect(timerSeconds(remainingAfterDelay)).toBeLessThan(
    timerSeconds(remainingBeforeDelay),
  );
  releaseSave();
  await expect(guidance).toContainText("1/14");
  await expect(guidance).not.toContainText("Now:");
  await expect(guidance).not.toContainText("Next:");
  await expect(statusBar.getByRole("region", { name: "Rest timer" }))
    .toContainText("Next: Romanian Deadlift, set 2");
  await page.unrouteAll({ behavior: "wait" });
  await expect
    .poll(() =>
      statusBar.evaluate((element) => ({
        overflow: element.scrollWidth - element.clientWidth,
        offset: element.scrollLeft,
      })),
    )
    .toEqual({ overflow: 0, offset: 0 });
  await expect
    .poll(() =>
      statusBar.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          rightGap: Math.round(window.innerWidth - box.right),
        };
      }),
    )
    .toEqual({ left: 0, rightGap: 0 });
  await expectNoHorizontalOverflow(page);
  await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
  await screenshot(page, "01-save-acknowledgement-starts-progress-and-rest.png");

  const rest = statusBar.getByLabel("Rest timer");
  await expect(rest).toBeVisible();
  await expect(statusBar).toHaveAttribute("data-rest-state", "running");
  const runningRestColors = await rest.evaluate((element) => ({
    strip: getComputedStyle(element).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor,
  }));
  expect(runningRestColors.strip).not.toBe(runningRestColors.page);
  const decreaseRest = rest.getByRole("button", { name: "Decrease rest by 15 seconds", exact: true });
  const decreaseRestAndWait = async (
    restRegion: Locator,
    decreaseButton: Locator,
  ) => {
    const remaining = restRegion.locator("span.tabular-nums").first();
    const before = timerSeconds(await remaining.textContent());
    await decreaseButton.click();
    await expect.poll(async () => {
      if (!(await decreaseButton.isVisible())) return -1;
      return timerSeconds(await remaining.textContent());
    }).toBeLessThanOrEqual(before - 10);
  };
  for (let index = 0; index < 6; index += 1) {
    await decreaseRestAndWait(rest, decreaseRest);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedDock = page.getByRole("complementary", { name: "Workout status" });
  const reloadedRest = reloadedDock.getByLabel("Rest timer");
  await expect(reloadedRest).toBeVisible();
  await expect(reloadedRest).toContainText("Next: Romanian Deadlift, set 2");

  const compactNavigation = page.getByRole("navigation", {
    name: "Primary navigation",
  });
  await page.setViewportSize({ width: 359, height: 700 });
  await expect(compactNavigation).toBeHidden();
  await page.setViewportSize({ width: 360, height: 700 });
  await expect(compactNavigation).toBeHidden();
  await page.setViewportSize({ width: 320, height: 700 });
  await expectNoHorizontalOverflow(page);
  const compactRest = reloadedDock.getByRole("region", {
    name: "Rest timer",
  });
  const reloadedDecrease = compactRest.getByRole("button", {
    name: "Decrease rest by 15 seconds",
    exact: true,
  });
  for (let index = 0; index < 4; index += 1) {
    if ((await compactRest.getAttribute("data-rest-phase")) !== "running") {
      break;
    }
    await decreaseRestAndWait(compactRest, reloadedDecrease);
  }
  await expect(compactRest).toContainText("Rest complete");
  await expect(compactRest).toContainText("Next: Romanian Deadlift, set 2");
  const collapsedMetrics = await reloadedDock.evaluate((element) => {
    const navigation = document.querySelector("nav.fixed");
    const navigationRect = navigation?.getBoundingClientRect() ?? null;
    const navigationVisible =
      navigation != null &&
      getComputedStyle(navigation).display !== "none" &&
      (navigationRect?.height ?? 0) > 0;
    const primary = Array.from(element.querySelectorAll("button")).filter(
      (button) =>
        button.dataset.testid === "active-log-set" ||
        button.getAttribute("aria-label") === "Review and finish workout",
    );
    return {
      dockBottom: element.getBoundingClientRect().bottom,
      navigationTop:
        navigationVisible
          ? navigationRect?.top ?? window.innerHeight
          : window.innerHeight,
      navigationVisible,
      primary: primary.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label: button.textContent?.trim() ?? "",
          width: box.width,
          height: box.height,
          bottom: box.bottom,
        };
      }),
    };
  });
  expect(collapsedMetrics.navigationVisible).toBe(false);
  expect(collapsedMetrics.dockBottom).toBeLessThanOrEqual(
    collapsedMetrics.navigationTop + 1,
  );
  expect(collapsedMetrics.primary).toHaveLength(2);
  expect(collapsedMetrics.primary.every((item) => item.width >= 44)).toBe(true);
  expect(collapsedMetrics.primary.every((item) => item.height >= 44)).toBe(true);
  expect(
    collapsedMetrics.primary.every(
      (item) => item.bottom <= collapsedMetrics.navigationTop + 1,
    ),
  ).toBe(true);
  await screenshot(page, "02-brief-rest-complete-320-extra-large.png");

  await expect(compactRest).toHaveCount(0, {
    timeout: 5_000,
  });
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("workout-tracker:rest-timer:v1");
    return raw == null ? null : JSON.parse(raw).phase;
  })).toBe("continued");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("region", { name: "Rest timer", exact: true }),
  ).toHaveCount(0);
  const resumedDock = page.getByRole("complementary", {
    name: "Workout status",
  });
  await skipCurrentSet(resumedDock);
  await expect(
    page.getByRole("region", {
      name: "Workout progress and upcoming work",
    }),
  ).toContainText("1/14");
  await expect(
    page.getByRole("region", {
      name: "Workout progress and upcoming work",
    }),
  ).toContainText("1 skipped");

  // Move through the remaining early Day B ledger without inventing performed
  // work. The actual upcoming occurrence then owns the EZ-curl preparation cue.
  for (let index = 0; index < 9; index += 1) {
    await skipCurrentSet(resumedDock);
  }
  await waitForSetSkippedNoticesToSettle(page);
  await skipCurrentSet(resumedDock);
  await expect(page.getByTestId("current-exercise-card").getByRole("heading", { level: 2 })).toHaveText(
    "EZ-Bar Curl",
  );
  const currentExercise = page.getByTestId("current-exercise-card");
  await expect(currentExercise.getByLabel("Total load", { exact: true }))
    .toHaveValue("40");
  await expect(currentExercise).toContainText(
    "Not loadable · nearest lower 38 lb · upper 43 lb",
  );
  await locatorScreenshot(
    currentExercise,
    "03-current-ez-curl-load-guidance-is-exact.png",
  );
  await openNativeDetails(currentExercise.getByTestId("active-exercise-details"));
  await currentExercise
    .getByRole("button", { name: "View alternatives", exact: true }).click();
  const alternatives = page.getByRole("dialog", {
    name: "Use an alternative for this workout",
  });
  await alternatives
    .getByRole("button", { name: "Discomfort", exact: true })
    .click();
  await alternatives
    .getByRole("button", { name: "Browse alternatives", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Alternatives to EZ-Bar Curl",
  });
  await picker
    .getByLabel("Search exercise library")
    .fill("Dumbbell Curl");
  const details = picker
    .getByRole("button", {
      name: "View details for Dumbbell Curl",
      exact: true,
    });
  await details.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await details.click({ timeout: 10_000 });
  const useAlternative = picker.getByRole("button", {
    name: "Use for this workout",
    exact: true,
  });
  await useAlternative.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await useAlternative.click({ timeout: 10_000 });
  const postSwapGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(postSwapGuidance).not.toContainText(/Per side:/);
  await expect(postSwapGuidance).not.toContainText("EZ curl bar (18 lb)");
  await expect(alternatives).toHaveCount(0);
  await waitForSetSkippedNoticesToSettle(page);
  await expect(currentExercise.getByRole("heading", { level: 2 })).toHaveText(
    "Dumbbell Curl",
  );
  await expect(currentExercise.getByLabel("Weight", { exact: true })).toBeVisible();
  await expect(currentExercise.getByLabel("Total load", { exact: true }))
    .toHaveCount(0);
  await expect(currentExercise).not.toContainText(
    /EZ curl bar|Per side|Empty bar|Not loadable/,
  );
  await locatorScreenshot(
    currentExercise,
    "04-substitution-suppresses-stale-precision.png",
  );

  await discardWorkout(page);
  await page.setViewportSize({ width: 440, height: 956 });
  let releaseEquipment!: () => void;
  const equipmentMayFinish = new Promise<void>((resolve) => {
    releaseEquipment = resolve;
  });
  let equipmentSelectionStarted = false;
  await page.route("**/session/**", async (route) => {
    const postData = route.request().postData() ?? "";
    if (
      !equipmentSelectionStarted &&
      route.request().method() === "POST" &&
      route.request().headers()["next-action"] &&
      postData.includes('"operation":"select"')
    ) {
      equipmentSelectionStarted = true;
      await equipmentMayFinish;
    }
    await route.continue();
  });
  await startProgramDay(page, "Day A — Squat", false);
  const groupDock = page.getByTestId("current-exercise-card");
  await openNativeDetails(groupDock.getByTestId("active-exercise-details"));
  await expect.poll(() => equipmentSelectionStarted).toBe(true);
  await expect(
    groupDock.getByRole("button", { name: "Skip set", exact: true }),
  ).toBeDisabled();
  releaseEquipment();
  await expect(
    groupDock.getByRole("button", { name: "Skip set", exact: true }),
  ).toBeEnabled();
  await page.unrouteAll({ behavior: "wait" });
  for (let index = 0; index < 9; index += 1) await skipCurrentSet(groupDock);
  const groupGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(groupGuidance).not.toContainText("Next:");
  await expect(groupGuidance).not.toContainText("Now:");
  await expect(groupDock).toContainText("Next action");
  await expect(groupDock).toContainText(
    "Superset, round 1, member 2 of 2: Pallof Press, set 1",
  );
  await expect(groupDock.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Dumbbell Lateral Raise, Set 1");
  await expect(groupGuidance).toContainText("0/13");
  await expect(groupGuidance).toContainText("9 skipped");
  await expect(
    page.getByRole("button", { name: "Open unsaved workout changes" }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  const durableGroupGuidance = page.getByRole("region", {
    name: "Workout progress and upcoming work",
  });
  await expect(durableGroupGuidance).toContainText("9 skipped");
  await expect(durableGroupGuidance).not.toContainText("Next:");
  await expect(durableGroupGuidance).not.toContainText("Now:");
  await expect(page.getByTestId("current-exercise-card")).toContainText(
    "Superset, round 1, member 2 of 2: Pallof Press, set 1",
  );
  await expect(page.getByTestId("active-workout-primary"))
    .toHaveAttribute("aria-label", "Dumbbell Lateral Raise, Set 1");
  await expect(
    page.getByRole("button", { name: "Open unsaved workout changes" }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await waitForSetSkippedNoticesToSettle(page);
  await screenshot(page, "05-group-round-and-member-wording.png");

  const evidence = {
    runId,
    automatedScope: [
      "440x956 Toronto mobile calibration",
      "320x700 extra-large text and collapsed fixed controls",
      "performed progress waits for save acknowledgement",
      "skips do not increment performed progress",
      "durable running-timer reload, elapsed return, and four-second completion collapse",
      "current, up-next, group round, and member wording",
      "18 lb EZ-curl preparation using the owned plate pool",
      "stale exact setup suppression after substitution",
      "equipment acknowledgement blocks stale workout-item changes",
      "skipped-item state remains durable after reload with no save queue",
    ],
    realDeviceOnly: [
      "locked-screen behavior",
      "silent-mode and hardware-volume routing",
      "Bluetooth/headphone routing",
      "physical vibration perception",
      "competing audio interruption",
      "device rotation behavior",
    ],
  };
  if (captureEvidence) {
    await writeFile(
      resolve(evidenceDirectory, "scope-and-real-device-boundary.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  expect(
    browserErrors.filter((message) => message !== "NEXT_REDIRECT"),
  ).toEqual([]);
  expect(
    requestFailures.filter(
      (failure) => !isExpectedOptimizedRequestCancellation(failure),
    ),
  ).toEqual([]);
  expect(
    httpErrors.filter(
      (failure) => !/^404 GET http:\/\/[^/]+\/api\/program\/draft$/.test(failure),
    ),
  ).toEqual([]);
});
