import { expect, test, type Page } from "@playwright/test";
import packageMetadata from "../../package.json";
import {
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import {
  isExpectedWebKitRscLinkCancellation,
} from "../helpers/webkit-rsc-prefetch-errors";

// The setup visits Today, Settings, and Coach. Validate that phase separately
// so its legitimate link prefetches cannot be confused with dismissal refresh.
const expectedSetupPrefetchPaths = new Set([
  "/today",
  "/history",
  "/coach",
  "/program",
  "/settings",
  "/simulation",
]);
// Coach and Simulation are deliberately absent during dismissal. The active
// Coach link does not prefetch, so a Coach cancellation is the real refresh.
const expectedDismissalPrefetchPaths = new Set([
  "/today",
  "/history",
  "/program",
  "/settings",
]);
const holdReason =
  "Barbell Bench Press is on hold because a 4/10 pain flag was saved in the last 14 days. It comes off hold 14 days after the latest 3/10 or higher flag. A workout with no pain entry doesn't shorten that time.";
const holdExplanation =
  "This notice doesn't change your Program. The current load stays in place until the evidence window above clears.";
const productVersionLabel = `Repbook v${packageMetadata.version}`;

async function signInAtExtraLargeText(page: Page) {
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page
    .getByPlaceholder("allowlisted email")
    .fill("review-decisions.e2e@example.com");
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);

  await page.goto("/settings");
  await expect(
    page.getByText(productVersionLabel, { exact: true }),
  ).toBeVisible();
  const extraLarge = page.getByRole("radio", { name: /Extra large 145%/ });
  if ((await extraLarge.getAttribute("aria-checked")) !== "true") {
    await waitForHydratedReactHandler(extraLarge);
    await extraLarge.click();
    await expect(
      page.getByText("Saved to your profile.", { exact: true }),
    ).toBeVisible();
  }
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preference: document.documentElement.dataset.fontSize,
        rootSize: Math.round(
          Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ) * 10,
        ) / 10,
      })),
    )
    .toEqual({ preference: "extra-large", rootSize: 23.2 });
}

test("explains the automatic pain hold without offering a Program change", async ({
  browserName,
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });

  await signInAtExtraLargeText(page);
  await page.goto("/coach");

  const hold = page
    .getByRole("region", { name: "Decisions needing review" })
    .locator("section")
    .filter({ hasText: "Barbell Bench Press" });
  await expect(hold).toHaveCount(1);
  await expect(hold.getByText("Automatic status", { exact: true })).toBeVisible();
  await expect(hold.getByText("Load held", { exact: true })).toBeVisible();
  await expect(hold.getByText(holdReason, { exact: true })).toBeVisible();
  await expect(hold.getByText(holdExplanation, { exact: true })).toBeVisible();
  await expect(hold.getByText("Highest recorded pain flag")).toBeVisible();
  await expect(hold.getByText("4", { exact: true })).toBeVisible();
  await expect(
    hold.getByText("Evidence window", { exact: true }),
  ).toBeVisible();
  await expect(hold.getByText("14 days", { exact: true })).toBeVisible();
  await expect(
    hold.getByRole("button", { name: /Approve/, exact: true }),
  ).toHaveCount(0);
  await expect(
    hold.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(
    browserErrors.filter(
      (message) =>
        !isExpectedWebKitRscLinkCancellation(
          message,
          browserName,
          expectedSetupPrefetchPaths,
        ),
    ),
  ).toEqual([]);
  browserErrors.length = 0;

  const dismiss = hold.getByRole("button", {
    name: "Dismiss notice",
    exact: true,
  });
  await expect(dismiss).toBeVisible();
  await expect
    .poll(() =>
      hold.evaluate(
        (element) =>
          element.getBoundingClientRect().right <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);

  if (browserName === "webkit") {
    await waitForHydratedReactHandler(dismiss);
    await dismiss.click();
    await expect(hold).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Recent decisions" })
        .getByText("Dismissed", { exact: true }),
    ).toHaveCount(1);
  }

  expect(
    browserErrors.filter(
      (message) =>
        !isExpectedWebKitRscLinkCancellation(
          message,
          browserName,
          expectedDismissalPrefetchPaths,
        ),
    ),
  ).toEqual([]);
});
