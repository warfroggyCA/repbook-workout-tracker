import { expect, test, type Locator, type Page } from "@playwright/test";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";
import { PRODUCTION_WORKOUT_START_PROGRAM } from "../fixtures/production-workout-start-contract";
import {
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

async function signIn(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
  });
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function chooseExtraLarge(page: Page) {
  await page.goto("/settings");
  const choice = page.getByRole("radio", { name: /Extra large/ });
  await waitForHydratedReactHandler(choice);
  await choice.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fontSize)).toBe("extra-large");
}

async function startPlanned(page: Page, doubleTap = false) {
  await page.goto("/today");
  const button = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(button);
  if (doubleTap) {
    await button.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
  } else {
    await button.click();
  }
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await page.waitForLoadState("networkidle");
}

async function startAlternate(page: Page, dayName: string) {
  await page.goto("/today");
  const alternatives = page.getByTestId("alternate-program-days");
  await alternatives.locator("summary").click();
  const preview = alternatives.getByRole("button", {
    name: new RegExp(dayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
  await preview.click();
  await expect(page).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
  const button = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(button);
  await button.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await page.waitForLoadState("networkidle");
}

async function discardActive(page: Page) {
  await page.goto("/today");
  const discard = page.getByRole("button", { name: "Discard this workout", exact: true });
  await waitForHydratedReactHandler(discard);
  await discard.click();
  const confirm = page.getByRole("button", { name: "Confirm discard", exact: true });
  await waitForHydratedReactHandler(confirm);
  await confirm.click();
  await expect(page.getByRole("button", { name: "Train as planned", exact: true })).toBeVisible();
}

async function injectFailure(button: Locator, value: "ambiguous" | "incomplete" | "render") {
  await button.evaluate((element, failure) => {
    const form = element.closest("form");
    if (!form) throw new Error("The workout start button has no form.");
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

async function clearInjectedFailure(button: Locator) {
  await button.evaluate((element) => {
    element.closest("form")?.querySelector('input[name="phase0StartFailure"]')?.remove();
  });
}

test("previews another Program day without starting it", async ({ page }) => {
  await signIn(page);

  const alternateDay = PRODUCTION_WORKOUT_START_PROGRAM.days[1].name;
  const alternatives = page.getByTestId("alternate-program-days");
  await alternatives.locator("summary").click();
  await alternatives.getByText(alternateDay, { exact: true }).click();

  await expect(page).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { level: 2, name: alternateDay, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Nothing starts until you choose Start workout.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start workout", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume workout", exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
  await expect(
    page.getByRole("button", { name: "Resume workout", exact: true }),
  ).toHaveCount(0);

  await page.goto("/today?preview=00000000-0000-4000-8000-000000000000");
  await expect(
    page.getByRole("alert").filter({
      hasText: "That Program day is no longer available",
    }),
  ).toContainText("Your current Program is shown below.");
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume workout", exact: true }),
  ).toHaveCount(0);

  await page.goBack();
  await page
    .getByRole("button", { name: "Back to today's plan", exact: true })
    .click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(
    page.getByRole("button", { name: "Train as planned", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume workout", exact: true }),
  ).toHaveCount(0);

  const reopenedAlternatives = page.getByTestId("alternate-program-days");
  await reopenedAlternatives.locator("summary").click();
  await reopenedAlternatives.getByText(alternateDay, { exact: true }).click();
  const start = page.getByRole("button", { name: "Start workout", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { level: 1, name: alternateDay, exact: true }),
  ).toBeVisible();
  await discardActive(page);
});

test("starts every Program day and recovers truthfully from creation and render failures", async ({
  page,
  context,
}, testInfo) => {
  const unexpectedErrors: string[] = [];
  let currentStep = "startup";
  const inspectError = (text: string) => {
    if (text.includes("_rsc=") && text.includes("due to access control checks")) return;
    unexpectedErrors.push(`${currentStep}: ${text}`);
  };
  page.on("console", (message) => {
    if (message.type() === "error") inspectError(message.text());
  });
  page.on("pageerror", (error) => inspectError(error.message));

  await signIn(page);
  await chooseExtraLarge(page);
  const rootPixels = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(rootPixels).toBeCloseTo(23.2, 1);

  currentStep = "day-start-matrix";
  await startPlanned(page, true);
  await expect(page.getByRole("heading", { level: 1, name: PRODUCTION_WORKOUT_START_PROGRAM.days[0].name })).toBeVisible();
  await discardActive(page);

  await startAlternate(page, PRODUCTION_WORKOUT_START_PROGRAM.days[1].name);
  await expect(page.getByRole("heading", { level: 1, name: PRODUCTION_WORKOUT_START_PROGRAM.days[1].name })).toBeVisible();
  await discardActive(page);

  await startAlternate(page, PRODUCTION_WORKOUT_START_PROGRAM.days[2].name);
  await expect(page.getByRole("heading", { level: 1, name: PRODUCTION_WORKOUT_START_PROGRAM.days[2].name })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: PRODUCTION_WORKOUT_START_PROGRAM.days[2].name })).toBeVisible();
  await discardActive(page);

  await startAlternate(page, PRODUCTION_WORKOUT_START_PROGRAM.days[1].name);
  await discardActive(page);

  currentStep = "concurrent-start";
  const secondPage = await context.newPage();
  await signIn(secondPage);
  await Promise.all([page.goto("/today"), secondPage.goto("/today")]);
  for (const candidate of [page, secondPage]) {
    const alternatives = candidate.getByTestId("alternate-program-days");
    await alternatives.locator("summary").click();
    const preview = alternatives.getByRole("button", {
      name: new RegExp(
        PRODUCTION_WORKOUT_START_PROGRAM.days[1].name.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        ),
      ),
    });
    await preview.click();
    await expect(candidate).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
    await waitForHydratedServerAction(
      candidate.getByRole("button", { name: "Start workout", exact: true }),
    );
  }
  const submitRenderedDay = (targetPage: Page) =>
    targetPage
      .getByRole("button", { name: "Start workout", exact: true })
      .evaluate((button) => {
        const form = button.closest("form");
        if (!(form instanceof HTMLFormElement)) {
          throw new Error("Workout start button must belong to a form.");
        }
        form.requestSubmit(button as HTMLButtonElement);
      });
  await Promise.all([submitRenderedDay(page), submitRenderedDay(secondPage)]);
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(secondPage).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await Promise.all([
    page.waitForLoadState("networkidle"),
    secondPage.waitForLoadState("networkidle"),
  ]);
  expect(new URL(page.url()).pathname).toBe(new URL(secondPage.url()).pathname);
  await secondPage.close();
  await discardActive(page);

  currentStep = "ambiguous-start-reconciliation";
  const ambiguous = page.getByRole("button", { name: "Train as planned", exact: true });
  await injectFailure(ambiguous, "ambiguous");
  await ambiguous.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await page.waitForLoadState("networkidle");
  await discardActive(page);

  currentStep = "render-failure-recovery";
  const planned = page.getByRole("button", { name: "Train as planned", exact: true });
  const renderFailureErrorStart = unexpectedErrors.length;
  await injectFailure(planned, "render");
  await planned.click();
  await expect(page.getByRole("heading", { name: "This workout was created", exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("render-failure-created-workout-recovery.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Return to Today", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume workout", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume workout", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await page.waitForLoadState("networkidle");
  const injectedRenderErrors = unexpectedErrors.splice(renderFailureErrorStart);
  expect(
    injectedRenderErrors.every((text) =>
      /Server Components render|Injected Phase 0 session render failure|due to access control checks/.test(text),
    ),
  ).toBe(true);

  currentStep = "unconfirmed-load-recovery";
  const activePath = new URL(page.url()).pathname;
  const unconfirmedLoadErrorStart = unexpectedErrors.length;
  await page.goto(`${activePath}?phase0LoadFailure=unconfirmed`);
  await expect(
    page.getByRole("heading", { name: "Check this workout’s status", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("This workout was created", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/no workout was created/i)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("unconfirmed-workout-status-recovery.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Return to Today", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume workout", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume workout", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${activePath}$`));
  await page.waitForLoadState("networkidle");
  const injectedUnconfirmedErrors = unexpectedErrors.splice(unconfirmedLoadErrorStart);
  expect(
    injectedUnconfirmedErrors.every((text) =>
      /Server Components render|Failed to load resource: the server responded with a status of 500|Injected Phase 0 unconfirmed session load failure|workout status could not be confirmed|due to access control checks/i.test(text),
    ),
  ).toBe(true);
  await discardActive(page);

  currentStep = "incomplete-creation-recovery";
  const alternatives = page.getByTestId("alternate-program-days");
  await alternatives.locator("summary").click();
  const dayCPreview = alternatives.getByRole("button", {
    name: new RegExp(
      PRODUCTION_WORKOUT_START_PROGRAM.days[2].name.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
    ),
  });
  await dayCPreview.click();
  const dayC = page.getByRole("button", { name: "Start workout", exact: true });
  await injectFailure(dayC, "incomplete");
  await dayC.click();
  await expect(page).toHaveURL(/\/today\?preview=[0-9a-f-]+$/);
  await expect(
    page.getByTestId("today-decision").getByText(/nothing was kept/i),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("incomplete-creation-inline-retry.png"),
    fullPage: true,
  });
  const retry = page.getByTestId("today-decision").getByRole("button", {
    name: `Try again — ${PRODUCTION_WORKOUT_START_PROGRAM.days[2].name}`,
    exact: true,
  });
  await clearInjectedFailure(retry);
  await retry.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await page.waitForLoadState("networkidle");
  await discardActive(page);

  const layoutCases = [
    { width: 320, size: "Compact" },
    { width: 375, size: "Default" },
    { width: 390, size: "Large" },
    { width: 440, size: "Extra large" },
  ] as const;
  for (const item of layoutCases) {
    currentStep = `layout-${item.width}-${item.size}`;
    await page.setViewportSize({ width: item.width, height: item.width === 320 ? 700 : 844 });
    await page.goto("/settings");
    const size = page.getByRole("radio", { name: new RegExp(item.size) });
    await waitForHydratedReactHandler(size);
    await size.click();
    await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.goto("/today");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath(`today-${item.width}-${item.size.toLowerCase().replace(" ", "-")}.png`),
      fullPage: true,
    });
  }

  expect(unexpectedErrors).toEqual([]);
});
