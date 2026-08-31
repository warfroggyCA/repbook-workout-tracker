import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  waitForEquipmentSelectionsToSettle,
  waitForHydratedReactChangeHandler,
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const evidenceDirectory = resolve(
  "output/playwright/plate-machine-guidance-evidence",
);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

async function signIn(page: Page) {
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

async function setExtraLargeText(page: Page) {
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large 145%/ });
  await extraLarge.click();
  await expect(extraLarge).toHaveAttribute("aria-checked", "true");
  const typography = await page.evaluate(() => ({
    key: document.documentElement.dataset.fontSize,
    rootPixels: Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    ),
  }));
  expect(typography.key).toBe("extra-large");
  expect(typography.rootPixels).toBeCloseTo(23.2, 3);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    layout.scrollWidth <= layout.clientWidth + 1,
    `${label} overflowed horizontally: ${JSON.stringify(layout)}`,
  ).toBe(true);
}

async function expectTouchTarget(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should be visible`).not.toBeNull();
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function expectPointerReachable(locator: Locator, label: string) {
  await locator.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  const reachable = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return (
      rect.top >= 0 &&
      rect.bottom <= innerHeight &&
      hit != null &&
      (hit === element || element.contains(hit))
    );
  });
  expect(reachable, `${label} should be reachable by an ordinary tap`).toBe(
    true,
  );
}

async function focusAcrossReactReconciliation(locator: Locator) {
  await expect
    .poll(
      async () => {
        if ((await locator.count()) !== 1) return false;
        try {
          await locator.focus();
          return locator.evaluate(
            (element) =>
              new Promise<boolean>((resolve) => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    resolve(document.activeElement === element);
                  });
                });
              }),
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(locator).toBeFocused();
}

function unexpectedBrowserErrors(errors: string[]) {
  return errors.filter(
    (error) =>
      error !== "Load failed" &&
      !error.includes("due to access control checks"),
  );
}

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name.includes("installed-like")) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        get: () => true,
      });
    });
  }
});

test("adds a plate-loaded machine with reviewed two-sided geometry", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("due to access control checks")
    ) {
      browserErrors.push(message.text());
    }
  });

  await signIn(page);
  await setExtraLargeText(page);
  await page.goto("/settings/equipment");
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await page.getByLabel("Search equipment types").fill("machine");
  await page
    .getByRole("button", { name: "Strength machine", exact: true })
    .click();

  const drawer = page.getByRole("dialog");
  const projectSuffix = testInfo.project.name.includes("installed-like")
    ? "installed"
    : testInfo.project.name.includes("webkit")
      ? "browser"
      : "desktop";
  const name = `Garage plate machine ${projectSuffix}`;
  await drawer.getByLabel("Name").fill(name);
  await expect(
    drawer.getByRole("button", { name: /^Plate-loaded/ }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: /^Weight stack/ }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: /^Not yet known/ }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: /^Plate-loaded/ }).click();
  await drawer.getByLabel("Calculation certainty").selectOption("known");
  await drawer.getByLabel("Starting resistance (lb)").fill("0");
  await drawer
    .getByRole("spinbutton", { name: "Loading points", exact: true })
    .fill("2");
  await drawer
    .getByLabel("How loading points are balanced")
    .selectOption("identical_each_point");
  await drawer
    .getByLabel("Entered workout load means")
    .selectOption("total_system");
  await expect(drawer).toContainText(
    "All owned lb plates are available by default.",
  );
  await expect(drawer).toContainText(
    "Select plate sizes only when this machine has an equipment-specific restriction.",
  );

  const nameInput = drawer.getByLabel("Name");
  await nameInput.focus();
  await expect(nameInput).toBeFocused();
  await expectNoHorizontalOverflow(page, "machine setup drawer");
  if (testInfo.project.name.includes("iphone")) {
    await expectTouchTarget(
      drawer.getByRole("button", { name: "Save changes", exact: true }),
      "Save changes",
    );
  }
  await drawer
    .getByLabel("Entered workout load means")
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(
      evidenceDirectory,
      `${testInfo.project.name}-01-machine-setup.png`,
    ),
    fullPage: false,
  });

  await drawer
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  const saveInventory = page.getByRole("button", {
    name: "Save inventory",
    exact: true,
  });
  await expect(saveInventory).toBeEnabled();
  await saveInventory.click();
  await expect(page).toHaveURL(/\/settings\?equipment-saved=updated$/);

  await page.goto("/settings/equipment");
  const savedCard = page.getByRole("button", {
    name: `Edit ${name}`,
    exact: true,
  });
  await expect(savedCard).toContainText("2 loading points");
  await savedCard.click();
  const savedDrawer = page.getByRole("dialog");
  await expect(
    savedDrawer.getByRole("button", { name: /^Plate-loaded/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(savedDrawer.getByLabel("Starting resistance (lb)")).toHaveValue(
    "0",
  );
  await expect(savedDrawer).toContainText(
    "All owned lb plates are available by default.",
  );
  for (const checkbox of await savedDrawer.getByRole("checkbox").all()) {
    await expect(checkbox).not.toBeChecked();
  }
  await expect(
    savedDrawer.getByRole("spinbutton", {
      name: "Loading points",
      exact: true,
    }),
  ).toHaveValue("2");
  await expect(unexpectedBrowserErrors(browserErrors)).toEqual([]);
});

test("shows live plates per side without changing total-load meaning", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("due to access control checks")
    ) {
      browserErrors.push(message.text());
    }
  });

  await signIn(page);
  await setExtraLargeText(page);
  await page.goto("/today");
  const resumeWorkout = page.getByRole("button", {
    name: "Resume workout",
    exact: true,
  });
  await waitForHydratedReactHandler(resumeWorkout);
  await resumeWorkout.click();
  await expect(page).toHaveURL(
    /\/session\/[0-9a-f-]+(?:#set-entry-[0-9a-f-]+-[0-9a-f-]+)?$/,
  );
  const currentCard = page.getByTestId("current-exercise-card");
  await expect(currentCard).toContainText("Plate-Loaded Lat Pulldown");
  await waitForEquipmentSelectionsToSettle(page);

  const input = currentCard.getByLabel("Total machine resistance");
  await waitForHydratedReactChangeHandler(input);
  await input.fill("100");
  await expect(input).toHaveValue("100");
  await expect(currentCard).toContainText(
    "45 + 5 lb per side · 100 lb total resistance",
  );
  await expect(currentCard).toContainText(
    "0 lb starting resistance + 50 lb × 2 sides",
  );
  await expect(currentCard).toContainText(
    "The entered 100 lb means total machine resistance.",
  );

  await input.fill("99");
  await expect(currentCard).toContainText(
    "99 lb is not achievable with the compatible owned plates",
  );
  await page.reload();
  await waitForEquipmentSelectionsToSettle(page);
  const reloadedCard = page.getByTestId("current-exercise-card");
  const reloadedInput = reloadedCard.getByLabel("Total machine resistance");
  // The invalid 99 lb edit must not replace the last valid persisted value.
  await expect(reloadedInput).toHaveValue("100");
  await expect(reloadedCard).toContainText(
    "45 + 5 lb per side · 100 lb total resistance",
  );
  const inputAfterReload = reloadedInput;
  await waitForHydratedReactChangeHandler(inputAfterReload);
  await focusAcrossReactReconciliation(inputAfterReload);
  const exactGuidance = reloadedCard.getByText(
    /45 \+ 5 lb per side · 100 lb total resistance/,
  );
  await exactGuidance.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  await expectNoHorizontalOverflow(page, "live machine set entry");
  await page.screenshot({
    path: resolve(
      evidenceDirectory,
      `${testInfo.project.name}-02-live-plates-per-side.png`,
    ),
    fullPage: false,
  });
  if (testInfo.project.name.includes("iphone")) {
    const logSet = reloadedCard.getByRole("button", {
      name: "Log set",
      exact: true,
    });
    await expectTouchTarget(
      logSet,
      "Log set",
    );
    await expectPointerReachable(logSet, "Log set");
    await page.screenshot({
      path: resolve(
        evidenceDirectory,
        `${testInfo.project.name}-03-live-log-touch.png`,
      ),
      fullPage: false,
    });
  }
  const viewportState = await page.evaluate(() => ({
    visualViewportHeight: window.visualViewport?.height ?? innerHeight,
    standalone:
      "standalone" in navigator
        ? Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
        : false,
  }));
  if (testInfo.project.name.includes("installed-like")) {
    expect(viewportState.standalone).toBe(true);
  }
  expect(viewportState.visualViewportHeight).toBeGreaterThan(0);
  await expect(unexpectedBrowserErrors(browserErrors)).toEqual([]);
});
