import { expect, test } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

async function signIn(
  page: import("@playwright/test").Page,
) {
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
  await page.waitForLoadState("networkidle");
}

test("opens and operates the keyboard-accessible Program editor", async ({
  page,
  browserName,
}) => {
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/program");
  await page.getByRole("button", { name: "Edit program", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("All changes saved");

  const editTab = page.getByRole("tab", { name: "Edit", exact: true });
  await editTab.focus();
  await expect(editTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const reviewTab = page.getByRole("tab", { name: "Review", exact: true });
  await expect(reviewTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reviewTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Review before activation" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  const versionsTab = page.getByRole("tab", { name: "Versions", exact: true });
  await expect(versionsTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(versionsTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Program versions" }),
  ).toBeVisible();

  await editTab.click();
  const discard = page.getByRole("button", {
    name: "Discard draft",
    exact: true,
  });
  await discard.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(discard).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    undersizedControls: [
      ...document.querySelectorAll<HTMLElement>(
        "main button:not([disabled]), main [role=tab]",
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.width < 40 || rect.height < 40);
      })
      .map(
        (element) =>
          element.textContent?.trim() || element.getAttribute("aria-label"),
      ),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.undersizedControls).toEqual([]);

  await page.goto("/program");
  let compilerEntry = page.getByText("Build session proposal", { exact: true });
  if (await compilerEntry.count() === 0) {
    await page.goto("/program/edit");
    await expect(page.getByRole("status")).toContainText("All changes saved");
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    await page.getByRole("button", { name: /Create semantic review|Review changes/ }).first().click();
    await expect(page.getByRole("heading", { name: "What will change" })).toBeVisible();
    await page.getByRole("button", { name: "Activate new version", exact: true }).click();
    await expect(page.getByText(/is now current/)).toBeVisible();
    await page.getByRole("link", { name: "View active Program", exact: true }).click();
    await expect(page).toHaveURL(/\/program$/);
    compilerEntry = page.getByText("Build session proposal", { exact: true });
  }
  await compilerEntry.click();
  await page.getByLabel("Time available").fill("90");
  await page.getByRole("button", { name: "Review deterministic proposal", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Proposed session", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every choice", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard proposal", exact: true }).click();
  await expect(page).toHaveURL(/\/program$/);
  const hasCancelledWebKitPrefetch =
    browserName === "webkit" &&
    errors.some(
      (message) =>
        message.includes("_rsc=") &&
        message.includes("due to access control checks"),
    );
  const unexpectedErrors = errors.filter((message) => {
    if (browserName === "firefox" && message === "Error in input stream") {
      return false;
    }
    if (!hasCancelledWebKitPrefetch) return true;
    return (
      message !== "Load failed" &&
      !(
        message.includes("_rsc=") &&
        message.includes("due to access control checks")
      )
    );
  });
  expect(unexpectedErrors).toEqual([]);
});
