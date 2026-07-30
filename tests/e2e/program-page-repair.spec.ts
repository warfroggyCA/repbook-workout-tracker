import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { isSuccessfulNextRscPrefetch } from "../helpers/webkit-rsc-prefetch-errors";

const fixtureEmail = "program-page.e2e@example.com";
const dayNames = [
  "Day 1 — Full-body strength and technique",
  "Day 2 — Hinge and upper-body pairing",
  "Day 3 — Accessories and steady practice",
];
const dayTabs = ["Day 1", "Day 2", "Day 3"];

function isWebKitDevelopmentRefreshNoise(
  browserName: string,
  message: string,
) {
  if (browserName !== "webkit") return false;
  return (
    message.includes("webpack.hot-update.json due to access control checks") ||
    (/[?&]_rsc=/.test(message) &&
      message.includes("due to access control checks")) ||
    message.includes(
      "__nextjs_original-stack-frames due to access control checks",
    ) ||
    (message.startsWith(
      "Failed to fetch RSC payload for http://127.0.0.1:3100/program?day=",
    ) && message.includes("TypeError: Load failed"))
  );
}

function collectUnexpectedErrors(
  page: Page,
  errors: string[],
  browserName: string,
  label: string,
) {
  page.on("pageerror", (error) => {
    if (!isWebKitDevelopmentRefreshNoise(browserName, error.message)) {
      errors.push(`${label} page error at ${page.url()}: ${error.message}`);
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:") &&
      !isWebKitDevelopmentRefreshNoise(browserName, message.text())
    ) {
      errors.push(`${label} console error at ${page.url()}: ${message.text()}`);
    }
  });
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(fixtureEmail);
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(/\/today$/);
  await page.waitForLoadState("networkidle");
}

test("repairs the saved Program compatibility, layout, and immediate day selection", async ({
  browser,
  browserName,
  context,
  page,
}, testInfo) => {
  const errors: string[] = [];
  collectUnexpectedErrors(page, errors, browserName, "primary");

  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/program");
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.waitForLoadState("networkidle");
  for (const name of dayTabs) {
    await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(1);
  }

  const [day1Href, day2Href, day3Href] = await Promise.all(
    dayTabs.map((name) =>
      page.getByRole("tab", { name, exact: true }).getAttribute("href")
    )
  );
  for (const href of [day1Href, day2Href, day3Href]) {
    expect(href).toMatch(/^\/program\?day=[0-9a-f-]+$/);
  }

  const directStarted = performance.now();
  await page.goto(day2Href!);
  const directLoadMs = Math.round(performance.now() - directStarted);
  await expect(
    page.getByRole("tab", { name: dayTabs[1], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Day 2: Hinge and upper-body pairing",
      exact: true,
    }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  const programRequests: string[] = [];
  const pendingProgramRequestClassifications = new Set<Promise<void>>();
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/program") {
      const classification = isSuccessfulNextRscPrefetch(request)
        .then((isPrefetch) => {
          if (!isPrefetch) {
            programRequests.push(
              `${request.method()} ${request.resourceType()} ${request.url()}`,
            );
          }
        })
        .catch(() => {
          programRequests.push(
            `${request.method()} ${request.resourceType()} ${request.url()}`,
          );
        });
      pendingProgramRequestClassifications.add(classification);
      void classification.finally(() =>
        pendingProgramRequestClassifications.delete(classification),
      );
    }
  });
  const settleProgramRequestClassifications = async () => {
    do {
      await Promise.all([...pendingProgramRequestClassifications]);
      // Request events are synchronous when a request starts. One quiet turn
      // also covers a request queued by the just-completed interaction.
      await page.waitForTimeout(50);
    } while (pendingProgramRequestClassifications.size > 0);
  };
  await page.route(/\/program\?day=/, async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    await route.continue();
  });

  const day1 = page.getByRole("tab", { name: dayTabs[0], exact: true });
  await waitForHydratedReactHandler(day1);
  const switchMeasureName = "program-day-switch-dom-ready";
  await day1.evaluate(
    (
      element,
      {
        expectedHref,
        expectedHeading,
        measureName,
      }: {
        expectedHref: string;
        expectedHeading: string;
        measureName: string;
      },
    ) => {
      const startMark = `${measureName}:start`;
      const endMark = `${measureName}:end`;
      const expectedUrl = new URL(expectedHref, window.location.href);
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
      performance.clearMeasures(measureName);

      element.addEventListener(
        "click",
        (event) => {
          if (!event.isTrusted) return;
          performance.mark(startMark);

          const recordWhenRendered = () => {
            const heading = [
              ...document.querySelectorAll<HTMLHeadingElement>("h2"),
            ].find(
              (candidate) =>
                candidate.textContent?.trim() === expectedHeading,
            );
            const headingRect = heading?.getBoundingClientRect();
            const headingStyle = heading ? getComputedStyle(heading) : null;
            const renderReady =
              `${window.location.pathname}${window.location.search}` ===
                `${expectedUrl.pathname}${expectedUrl.search}` &&
              element.getAttribute("aria-selected") === "true" &&
              headingRect != null &&
              headingRect.width > 0 &&
              headingRect.height > 0 &&
              headingStyle?.display !== "none" &&
              headingStyle?.visibility !== "hidden";

            if (!renderReady) return;
            observer.disconnect();
            // Include the rest of the trusted click's event turn so synchronous
            // work after the DOM commit still counts. A timer avoids treating
            // headless frame scheduling as application response time.
            window.setTimeout(() => {
              performance.mark(endMark);
              performance.measure(measureName, startMark, endMark);
            }, 0);
          };
          const observer = new MutationObserver(recordWhenRendered);
          observer.observe(document.body, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
          });
          queueMicrotask(recordWhenRendered);
        },
        { capture: true, once: true },
      );
    },
    {
      expectedHref: day1Href!,
      expectedHeading: dayNames[0],
      measureName: switchMeasureName,
    },
  );
  // WebKit can finish delayed RSC work from the direct page load while the
  // click measurement is being installed. Only requests beginning with the
  // trusted day-switch window belong to this zero-navigation assertion.
  await settleProgramRequestClassifications();
  programRequests.length = 0;
  await day1.click();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day1Href
  );
  await expect(day1).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Day 1 — Full-body strength and technique",
      exact: true,
    }),
  ).toBeVisible();
  await settleProgramRequestClassifications();
  expect(programRequests).toEqual([]);
  await expect
    .poll(() =>
      day1.evaluate(
        (element, measureName) => {
          void element;
          return (
            performance.getEntriesByName(measureName, "measure")[0]
              ?.duration ?? null
          );
        },
        switchMeasureName,
      ),
    )
    .not.toBeNull();
  const switchMs = Math.round(
    (await day1.evaluate(
      (element, measureName) => {
        void element;
        return performance.getEntriesByName(measureName, "measure")[0]
          ?.duration;
      },
      switchMeasureName,
    )) ?? Number.POSITIVE_INFINITY,
  );
  expect(switchMs).toBeLessThan(250);

  const warmup = page.getByRole("region", { name: "Warm-up", exact: true });
  await expect(warmup).toHaveCount(1);
  await expect(warmup).toContainText(
    "Five minutes easy, then shoulder circles.",
  );
  await expect(warmup).toContainText(
    "Before Barbell Bench Press: Empty bar · 10 reps",
  );
  await expect(warmup).toContainText(
    "Before Barbell Bench Press: First ramp · 55% of work weight · 5 reps · Move smoothly",
  );
  await expect(warmup).toContainText(
    "Before Barbell Bench Press: Second ramp · 85 lb · 3 reps",
  );
  await expect(page.getByText(/Legacy exercise warm-up retained/i)).toHaveCount(
    0,
  );
  await expect(page.getByText(/\bNone\b/)).toHaveCount(0);
  await expect(page.getByText(/load percent|load text|load unit/i)).toHaveCount(
    0,
  );

  const day2 = page.getByRole("tab", { name: dayTabs[1], exact: true });
  const day3 = page.getByRole("tab", { name: dayTabs[2], exact: true });
  await day2.click();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day2Href
  );
  await expect(day2).toHaveAttribute("aria-selected", "true");
  await day3.click();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day3Href
  );
  await expect(day3).toHaveAttribute("aria-selected", "true");
  await day1.click();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day1Href
  );
  await expect(day1).toHaveAttribute("aria-selected", "true");
  await settleProgramRequestClassifications();
  expect(programRequests).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day3Href
  );
  await expect(day3).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day2Href
  );
  await expect(day2).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day3Href
  );
  await expect(day3).toHaveAttribute("aria-selected", "true");
  await settleProgramRequestClassifications();
  expect(programRequests).toEqual([]);

  await day1.focus();
  await expect(day1).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(day2).toBeFocused();
  await expect(day3).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day2Href
  );
  await expect(day2).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(day3).toBeFocused();
  await expect(day2).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === day3Href
  );
  await expect(day3).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(day1).toBeFocused();
  await settleProgramRequestClassifications();
  expect(programRequests).toEqual([]);

  const day3Url = page.url();
  const documentIdentity = await page.evaluate(() => {
    const identity = crypto.randomUUID();
    Object.defineProperty(window, "__programDocumentIdentity", {
      configurable: true,
      value: identity,
    });
    return identity;
  });
  const currentDocumentIdentity = () =>
    page.evaluate(
      () =>
        Reflect.get(
          window,
          "__programDocumentIdentity",
        ) as unknown,
    );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Today", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
  expect(await currentDocumentIdentity()).toBe(documentIdentity);
  await page.goBack();
  await expect(page).toHaveURL(day3Url);
  await expect(
    page.getByRole("tab", { name: dayTabs[2], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(await currentDocumentIdentity()).toBe(documentIdentity);

  await page.reload();
  await expect(
    page.getByRole("tab", { name: dayTabs[2], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toBe(day3Url);

  const copiedTab = await context.newPage();
  await installNextDevelopmentRefreshControl(copiedTab);
  collectUnexpectedErrors(copiedTab, errors, browserName, "copied tab");
  await copiedTab.goto(day2Href!);
  await expect(
    copiedTab.getByRole("tab", { name: dayTabs[1], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await copiedTab.close();

  const touchContext = await browser.newContext({
    hasTouch: true,
    storageState: await context.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const touchPage = await touchContext.newPage();
  await installNextDevelopmentRefreshControl(touchPage);
  collectUnexpectedErrors(touchPage, errors, browserName, "touch page");
  await touchPage.goto("/today");
  const touchProgramLink = touchPage.getByRole("link", {
    name: "Program",
    exact: true,
  });
  await waitForHydratedReactHandler(touchProgramLink);
  await touchProgramLink.click();
  await expect(touchPage).toHaveURL(/\/program$/);
  let touchProgramRequests = 0;
  touchPage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/program") {
      touchProgramRequests += 1;
    }
  });
  const touchDay2 = touchPage.getByRole("tab", {
    name: "Day 2",
    exact: true,
  });
  await waitForHydratedReactHandler(touchDay2);
  await touchDay2.tap();
  await expect(
    touchPage.getByRole("tab", { name: "Day 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(touchProgramRequests).toBe(0);
  await touchContext.close();

  const noScriptContext = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await context.storageState(),
  });
  const noScriptPage = await noScriptContext.newPage();
  collectUnexpectedErrors(noScriptPage, errors, browserName, "no-script page");
  await noScriptPage.goto(day2Href!);
  await expect(
    noScriptPage.getByRole("tab", { name: dayTabs[1], exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    noScriptPage.getByRole("heading", {
      name: "Day 2: Hinge and upper-body pairing",
      exact: true,
    }),
  ).toBeVisible();
  await noScriptContext.close();

  await page.goto("/program?day=unknown-day-identity");
  await expect(
    page.getByRole("tab", { name: dayTabs[0], exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  const sizes = ["compact", "default", "large", "extra-large"];
  const widths = [320, 390, 768, 960, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const size of sizes) {
      await page.evaluate((fontSize) => {
        document.documentElement.dataset.fontSize = fontSize;
      }, size);
      const layout = await page.evaluate(() => {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            "main a, main button, main [role=tab]",
          ),
        ].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const actions = [
          ...document.querySelectorAll<HTMLElement>("main > div > header a"),
        ];
        const title = document.querySelector<HTMLElement>("main h1");
        const titleRect = title?.getBoundingClientRect() ?? null;
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          clippedActions: actions
            .filter((action) => action.scrollWidth > action.clientWidth + 1)
            .map((action) => action.textContent?.trim()),
          titleActionOverlap: actions.some((action) => {
            if (!titleRect) return false;
            const rect = action.getBoundingClientRect();
            return (
              rect.left < titleRect.right &&
              rect.right > titleRect.left &&
              rect.top < titleRect.bottom &&
              rect.bottom > titleRect.top
            );
          }),
          undersizedControls: controls
            .filter((control) => {
              const rect = control.getBoundingClientRect();
              return rect.width < 40 || rect.height < 40;
            })
            .map(
              (control) =>
                control.textContent?.trim() ||
                control.getAttribute("aria-label"),
            ),
        };
      });
      expect(layout.scrollWidth, `${width}px ${size}`).toBeLessThanOrEqual(
        layout.clientWidth + 1,
      );
      expect(layout.clippedActions, `${width}px ${size}`).toEqual([]);
      expect(layout.titleActionOverlap, `${width}px ${size}`).toBe(false);
      expect(layout.undersizedControls, `${width}px ${size}`).toEqual([]);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.fontSize = "extra-large";
  });
  const artifactDir = resolve("output/playwright/program-page-repair");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    path: resolve(artifactDir, "repaired-1440-extra-large.png"),
    fullPage: true,
  });

  const edit = page.getByRole("button", { name: "Edit program", exact: true });
  await waitForHydratedReactHandler(edit);
  await edit.click();
  await expect(page).toHaveURL(/\/program\/edit\?day=/);
  await expect(page.getByRole("status")).toContainText("All changes saved");
  const editDay1 = page.getByRole("tab", { name: dayNames[0], exact: true });
  const editDay3 = page.getByRole("tab", { name: dayNames[2], exact: true });
  await expect(editDay1).toHaveAttribute("aria-selected", "true");
  await waitForHydratedReactHandler(editDay3);
  await editDay3.click();
  await expect(editDay3).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/program\/edit\?day=/);
  await page.goBack();
  await expect(editDay1).toHaveAttribute("aria-selected", "true");

  const performanceEvidence = JSON.stringify(
    {
      baseline: {
        clickToSelectedMs: 3094,
        programRequestsPerSwitch: 1,
        directServerResponseMs: 32,
      },
      repaired: {
        clickToSelectedMs: switchMs,
        programRequestsPerSwitch: 0,
        directLoadMs,
      },
    },
    null,
    2,
  );
  await writeFile(
    resolve(artifactDir, "performance.json"),
    `${performanceEvidence}\n`,
    "utf8",
  );
  await testInfo.attach("program-page-performance.json", {
    body: Buffer.from(performanceEvidence),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});
