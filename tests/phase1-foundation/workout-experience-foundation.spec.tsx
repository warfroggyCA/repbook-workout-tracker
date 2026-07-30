import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const runId = process.env.PHASE1_RUN_ID ?? `phase1-local-${Date.now()}`;
const evidenceDirectory = resolve(
  "output/playwright/phase1-workout-experience",
  runId,
  "evidence",
);

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/(?:today|setup\/profile)$/);
  await page.waitForLoadState("networkidle");
}

async function chooseAppSize(page: Page, name: RegExp) {
  await page.goto("/settings");
  const option = page.getByRole("radio", { name });
  if ((await option.getAttribute("aria-checked")) !== "true") {
    await waitForHydratedReactHandler(option);
    await option.click();
    await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  }
}

async function assertLayout(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);

  const clippedControls = await page.locator("button:visible, a:visible").evaluateAll((elements) =>
    elements
      .filter((element) => {
        const label = element.textContent ?? "";
        const hasSeparateAccessibleLabel =
          element.hasAttribute("aria-label") || element.hasAttribute("title");
        return !hasSeparateAccessibleLabel && label.trim().length > 0 &&
          (element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1);
      })
      .map((element) => (element.textContent ?? "").trim()),
  );
  expect(clippedControls).toEqual([]);
}

async function capture(page: Page, name: string) {
  await assertLayout(page);
  await page.screenshot({ path: resolve(evidenceDirectory, name), fullPage: true });
}

test("records the responsive and accessibility foundation without production writes", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const httpErrors: string[] = [];
  const expectedRequestCancellations: string[] = [];
  const expectedPageCancellations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (
      error.message.includes("?_rsc=") &&
      error.message.includes("due to access control checks.")
    ) {
      expectedPageCancellations.push(error.message);
    } else {
      pageErrors.push(error.message);
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const reason = request.failure()?.errorText ?? "unknown";
    const expectedRscCancellation =
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      url.searchParams.has("_rsc") &&
      request.headers().rsc === "1" &&
      ["net::ERR_ABORTED", "cancelled"].includes(reason);
    const expectedActionCancellation =
      request.method() === "POST" &&
      !request.isNavigationRequest() &&
      Boolean(request.headers()["next-action"]) &&
      ["/sign-in", "/settings"].includes(url.pathname) &&
      reason === "net::ERR_ABORTED";
    if (expectedRscCancellation || expectedActionCancellation) {
      expectedRequestCancellations.push(
        `${request.method()} ${url.pathname}${url.search} — ${reason}`,
      );
    } else {
      requestFailures.push(`${request.method()} ${url.pathname} — ${reason}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const url = new URL(response.url());
      httpErrors.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);

  const sizes = [
    { name: /Compact 100%/, key: "compact" },
    { name: /Default 115%/, key: "default" },
    { name: /Large 130%/, key: "large" },
    { name: /Extra large 145%/, key: "extra-large" },
  ];
  for (const size of sizes) {
    await chooseAppSize(page, size.name);
    await page.goto("/today");
    await expect(page.locator("html")).toHaveAttribute("data-font-size", size.key);
    await capture(page, `today-375-${size.key}.png`);
  }

  await chooseAppSize(page, /Extra large 145%/);
  const surfaces = [
    ["today", "/today"],
    ["history", "/history"],
    ["review", "/coach"],
    ["program", "/program"],
    ["settings", "/settings"],
    ["recovery", "/recovery"],
    ["simulation", "/simulation"],
  ] as const;
  const viewports = [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 440, height: 956 },
    { width: 1440, height: 900 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const [label, route] of surfaces) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      await capture(page, `${label}-${viewport.width}-extra-large.png`);
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/program");
  const dayTab = page.getByRole("tab").first();
  await dayTab.focus();
  await expect(dayTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dayTab).toBeFocused();
  await expect(dayTab).toHaveAttribute("aria-selected", "true");

  await page.goto("/phase1-foundation");
  const notices = page.locator('[data-slot="state-notice"]');
  await expect(notices).toHaveCount(7);
  await expect(notices.filter({ has: page.getByText(/needs attention —/) })).toHaveAttribute("role", "alert");
  await expect(notices.filter({ has: page.getByText(/saving —/) })).toHaveAttribute("role", "status");
  for (const control of await page.locator("#phase1-foundation-proof button").all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  const firstFoundationAction = page
    .locator("#phase1-foundation-proof button")
    .first();
  await firstFoundationAction.focus();
  await expect(firstFoundationAction).toBeFocused();
  await capture(page, "shared-states-375-extra-large.png");

  const observations = {
    consoleErrors,
    pageErrors,
    requestFailures,
    httpErrors,
    expectedRequestCancellations,
    expectedPageCancellations,
  };
  await writeFile(
    resolve(evidenceDirectory, "browser-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
    { flag: "wx" },
  );
  expect({ consoleErrors, pageErrors, requestFailures, httpErrors }).toEqual({
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
  });
});
