import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscLinkCancellation,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

const EXPECTED_APP_SHELL_PREFETCHES = new Set(["/history"]);

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function openAlternatePreview(page: Page, day: RegExp) {
  const current = new URL(page.url());
  if (current.pathname !== "/today" || current.search) {
    await page.waitForLoadState("networkidle");
    await page.goto("/today");
  }
  const alternatives = page.getByTestId("alternate-program-days");
  await alternatives.locator("summary").click();
  await alternatives.getByRole("button", { name: day }).click();
  await expect(page).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  return start;
}

async function startRequestKey(button: Locator) {
  return button.evaluate((element) => {
    const input = element.closest("form")?.querySelector<HTMLInputElement>(
      'input[name="startRequestKey"]',
    );
    return input?.value ?? "";
  });
}

async function injectFailure(button: Locator, value: "ambiguous" | "incomplete") {
  await button.evaluate((element, failure) => {
    const form = element.closest("form");
    if (!form) throw new Error("Start must belong to a form.");
    let input = form.querySelector<HTMLInputElement>('input[name="phase0StartFailure"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "phase0StartFailure";
      form.append(input);
    }
    input.value = failure;
  }, value);
}

async function clearFailure(button: Locator) {
  await button.evaluate((element) => {
    element.closest("form")?.querySelector('input[name="phase0StartFailure"]')?.remove();
  });
}

async function discardActive(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.goto("/today");
  const discard = page.getByRole("button", { name: "Discard this workout", exact: true });
  await waitForHydratedReactHandler(discard);
  await discard.click();
  const confirm = page.getByRole("button", { name: "Confirm discard", exact: true });
  await waitForHydratedReactHandler(confirm);
  await confirm.click();
  await expect(page.getByRole("button", { name: "Train as planned", exact: true }))
    .toBeVisible();
}

async function submit(button: Locator) {
  await button.evaluate((element) => {
    const form = element.closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Start form is missing.");
    form.requestSubmit(element as HTMLButtonElement);
  });
}

test("keeps preview read-only and Start replay-safe with truthful active collisions", async ({
  browserName,
  context,
  page,
}) => {
  const browserErrors: string[] = [];
  const nextRscPrefetches = observeNextRscPrefetches(page, browserName);
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await signIn(page);

  const serverResponse = await page.goto("/today");
  const serverHtml = await serverResponse?.text();
  const serverKey = serverHtml?.match(
    /name="startRequestKey" value="([0-9a-f-]{36})"/,
  )?.[1];
  expect(serverKey).toMatch(/^[0-9a-f-]{36}$/);
  const plannedStart = page.getByRole("button", {
    name: "Train as planned",
    exact: true,
  });
  await waitForHydratedServerAction(plannedStart);
  expect(await startRequestKey(plannedStart)).toBe(serverKey);

  let start = await openAlternatePreview(page, /Day A — Squat/);
  await expect(page.getByText("Nothing starts until you choose Start workout.", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Resume workout", exact: true }))
    .toHaveCount(0);
  const previewKey = await startRequestKey(start);
  expect(previewKey).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume workout", exact: true }))
    .toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Resume workout", exact: true }))
    .toHaveCount(0);

  start = await openAlternatePreview(page, /Day A — Squat/);
  await injectFailure(start, "incomplete");
  const retryKey = await startRequestKey(start);
  await start.click();
  await expect(page.getByText("The workout was not created completely", { exact: false }))
    .toBeVisible();
  start = page.getByRole("button", { name: /Try again —/ });
  expect(await startRequestKey(start)).toBe(retryKey);
  await clearFailure(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: /Day A — Squat/ }))
    .toBeVisible();
  await discardActive(page);

  const ambiguous = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(ambiguous);
  await injectFailure(ambiguous, "ambiguous");
  await ambiguous.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await discardActive(page);

  const second = await context.newPage();
  await signIn(second);
  const planned = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(planned);
  const alternate = await openAlternatePreview(second, /Day C — Bench/);
  const requested = new Map<Page, string>([
    [page, "Day B — Hinge"],
    [second, "Day C — Bench"],
  ]);
  await Promise.all([submit(planned), submit(alternate)]);
  await expect.poll(() => [page.url(), second.url()].filter((url) => /\/session\//.test(url)).length)
    .toBe(1);
  await expect.poll(() => [page.url(), second.url()].filter((url) => /\/today\?start=active/.test(url)).length)
    .toBe(1);
  const winner = /\/session\//.test(page.url()) ? page : second;
  const loser = winner === page ? second : page;
  await expect(winner.getByRole("heading", {
    level: 1,
    name: requested.get(winner)!,
    exact: true,
  })).toBeVisible();
  await expect(loser.getByText("The workout you requested was not started", { exact: false }))
    .toBeVisible();
  await expect(loser.getByRole("button", { name: "Resume workout", exact: true }))
    .toBeVisible();
  expect(
    await loser.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await second.close();
  await discardActive(page);
  await nextRscPrefetches.settle();
  const expectedLinkCancellationCount = browserErrors.filter((message) =>
    isExpectedWebKitRscLinkCancellation(
      message,
      browserName,
      EXPECTED_APP_SHELL_PREFETCHES,
    )
  ).length;
  const loadFailureCount = browserErrors.filter(
    (message) => message === "Load failed",
  ).length;
  const hasOnlyPairedWebKitLoadFailures =
    browserName === "webkit" &&
    expectedLinkCancellationCount > 0 &&
    loadFailureCount <= expectedLinkCancellationCount;
  expect(browserErrors.filter(
    (message) =>
      !(hasOnlyPairedWebKitLoadFailures && message === "Load failed") &&
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
  )).toEqual([]);
});
