import { expect, test, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const exerciseName = "Barbell Back Squat";

async function signIn(page: Page) {
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
}

test("keeps every Program editor entry point unavailable while the rollout flag is off", async ({
  page,
  request,
}) => {
  const maintenance = await request.post("/api/maintenance/progression", {
    headers: { authorization: "Bearer local-e2e-maintenance-secret" },
  });
  expect(maintenance.status()).toBe(200);
  expect((await maintenance.json()) as { completed: number }).toMatchObject({
    completed: 1,
  });

  await signIn(page);

  await page.goto("/program");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Edit Program", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Build session proposal", { exact: true }),
  ).toHaveCount(0);

  const editResponse = await page.goto("/program/edit");
  expect(editResponse?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "This page could not be found." }),
  ).toBeVisible();

  const compileResponse = await page.goto("/program/compile");
  expect(compileResponse?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "This page could not be found." }),
  ).toBeVisible();

  const apiResults = await page.evaluate(async () => {
    const draftId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const mutationId = crypto.randomUUID();
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/program/draft", undefined],
      ["/api/program/draft", { method: "POST" }],
      [
        "/api/program/draft",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftId,
            expectedRevision: 1,
            mutationId,
            document: {},
          }),
        },
      ],
      [
        "/api/program/draft",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId, expectedRevision: 1 }),
        },
      ],
      [
        "/api/program/draft/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draftId, expectedRevision: 1 }),
        },
      ],
      [
        "/api/program/draft/publish",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftId,
            expectedRevision: 1,
            reviewHash: "0".repeat(64),
          }),
        },
      ],
      [
        "/api/program/draft/restore",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId,
            currentDraftId: draftId,
            expectedRevision: 1,
            mutationId,
          }),
        },
      ],
      [`/api/program/versions/${versionId}/export`, undefined],
      [`/api/program/versions/${versionId}/compare`, undefined],
    ];

    return Promise.all(
      requests.map(async ([url, init]) => {
        const response = await fetch(url, init);
        return { url, method: init?.method ?? "GET", status: response.status };
      }),
    );
  });

  expect(apiResults).toHaveLength(9);
  expect(apiResults.map(({ status }) => status)).toEqual(Array(9).fill(404));

  await page.goto("/coach");
  const suggestions = page.getByRole("region", {
    name: "Decisions needing review",
  });
  const recommendation = suggestions.locator("section").filter({
    has: page.getByText(exerciseName, { exact: true }),
  });
  await expect(recommendation).toHaveCount(1);
  await recommendation
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(recommendation).toContainText(
    "Program version changes are temporarily unavailable.",
  );

  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Decisions needing review" })
      .getByText(exerciseName, { exact: true }),
  ).toHaveCount(1);
  await page.goto("/program");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();
});
