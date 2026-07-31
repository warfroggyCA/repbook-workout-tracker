import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

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

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

test("opens the preserved draft and expires a pre-Phase-2 review on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  const isExpectedWebKitPrefetchRefusal = (text: string) =>
    text.includes("127.0.0.1:3100/") &&
    text.includes("?_rsc=") &&
    text.includes("due to access control checks.");
  page.on("pageerror", (error) => {
    if (!isExpectedWebKitPrefetchRefusal(error.message)) {
      errors.push(error.message);
    }
  });
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" &&
      !text.startsWith("Failed to load resource:") &&
      !isExpectedWebKitPrefetchRefusal(text)
    ) {
      errors.push(text);
    }
  });

  await signIn(page);
  await page.goto("/program/edit");
  await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();
  const name = page.getByLabel("Program name");
  await name.fill("PROGRAM-001 preserved owner draft");
  await expect(page.getByRole("status")).toContainText("All changes saved");

  await page.route("**/api/program/draft", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    if (response.ok() && payload?.draft) {
      const revision = payload.draft.revision;
      payload.draft.reviewedRevision = revision;
      payload.draft.reviewHash = "c".repeat(64);
      payload.draft.reviewSummary = {
        hash: "c".repeat(64),
        reviewedRevision: revision,
        changes: [],
        blockingErrors: [],
        cautions: [],
        recommendationRevision: 0,
        recommendationConsequences: [],
        summary: {
          weeklySetsBefore: 3,
          weeklySetsAfter: 3,
          estimatedMinutesBefore: 30,
          estimatedMinutesAfter: 30,
          muscleSetsBefore: {},
          muscleSetsAfter: {},
        },
      };
    }
    await route.fulfill({
      response,
      json: payload,
    });
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: /^Edit / })).toBeVisible();
  await expect(name).toHaveValue("PROGRAM-001 preserved owner draft");
  await expect(
    page.getByText("Fresh review required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/durable draft and Program version history are unchanged/i))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry loading draft", exact: true }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);

  await page.unroute("**/api/program/draft");
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Program versions", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Check Program", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to activate", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fresh review required", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Activate new version", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel("Program name")).toHaveValue(
    "PROGRAM-001 preserved owner draft",
  );
  expect(errors).toEqual([]);
});
