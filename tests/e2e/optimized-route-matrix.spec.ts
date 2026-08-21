import { expect, test } from "@playwright/test";
import packageMetadata from "../../package.json";
import {
  installLocalAuthSession,
  policyNonce,
  visitRenderedDocument,
} from "../helpers/browser-security";
import { OPTIMIZED_ROUTE_ACTIVITY_ID } from "../helpers/optimized-route-fixture-values";

const productVersionLabel = `Repbook v${packageMetadata.version}`;

test("renders every optimized page family under its request nonce", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The optimized browser base URL is required.");
  await installLocalAuthSession(context, baseURL);
  const draftResponse = await page.request.post("/api/program/draft", {
    headers: { origin: baseURL },
  });
  expect(
    draftResponse.status(),
    "The optimized Program editor fixture could not create its disposable draft."
  ).toBe(200);

  const browserErrors: string[] = [];
  const policyViolations: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") browserErrors.push(text);
    if (/content security policy|refused to (load|execute|apply)|csp/i.test(text)) {
      policyViolations.push(text);
    }
  });

  const staticRoutes = [
    ["/", "Today · Repbook"],
    ["/today", "Today · Repbook"],
    ["/history", "History · Repbook"],
    ["/coach", "Review and decisions · Repbook"],
    ["/program", "Program · Repbook"],
    ["/program/edit", "Program · Repbook"],
    ["/program/import", "Program · Repbook"],
    ["/settings", "Settings · Repbook"],
    ["/settings/audit", "Settings · Repbook"],
    ["/settings/equipment", "Settings · Repbook"],
    ["/settings/setup", "Settings · Repbook"],
    ["/settings/setup/profile", "Settings · Repbook"],
    ["/settings/setup/equipment", "Settings · Repbook"],
    ["/settings/setup/constraints", "Settings · Repbook"],
    ["/settings/setup/coaching", "Settings · Repbook"],
    ["/settings/setup/program", "Settings · Repbook"],
    ["/export", "Downloads & backup · Repbook"],
    ["/archive", "Archive · Repbook"],
    ["/recovery", "Recovery · Repbook"],
    ["/recovery/semantic-consequences", "Recovery · Repbook"],
    ["/recovery/versions", "Recovery · Repbook"],
    ["/activity/new", "Activity record · Repbook"],
    ["/setup", "Settings · Repbook"],
  ] as const;
  for (const [route, title] of staticRoutes) {
    await visitRenderedDocument(page, route);
    await expect(page, `${route} did not expose its route meaning`).toHaveTitle(
      title
    );
    if (route === "/settings") {
      await expect(
        page.getByText(productVersionLabel, { exact: true }),
      ).toBeVisible();
    }
  }

  // First-time setup steps are redirect-only for this completed account:
  // verify the direct response policy and the exact safe destination.
  for (const step of [
    "profile",
    "equipment",
    "constraints",
    "routine",
    "coaching",
    "review",
  ]) {
    const route = `/setup/${step}`;
    const stepResponse = await page.request.get(route, { maxRedirects: 0 });
    expect([303, 307], `${route} must redirect a completed account`).toContain(
      stepResponse.status()
    );
    expect(
      new URL(stepResponse.headers().location!, baseURL).pathname
    ).toBe("/settings/setup");
    policyNonce(
      stepResponse.headers()["content-security-policy"] ?? "",
      route
    );
  }

  await visitRenderedDocument(page, "/history");
  const historyHref = await page
    .locator('a[href^="/history/"]')
    .first()
    .getAttribute("href");
  expect(historyHref, "The seeded workout detail route was missing.").toBeTruthy();
  await visitRenderedDocument(page, historyHref!);
  await expect(page).toHaveTitle("History · Repbook");

  await visitRenderedDocument(page, "/today");
  const sessionHref = await page
    .locator('a[href^="/session/"]')
    .first()
    .getAttribute("href");
  expect(sessionHref, "The seeded active-session route was missing.").toBeTruthy();
  await visitRenderedDocument(page, sessionHref!);
  await expect(page).toHaveTitle("Active workout · Repbook");

  await visitRenderedDocument(page, `/activity/${OPTIMIZED_ROUTE_ACTIVITY_ID}`);
  await expect(page).toHaveTitle("Activity record · Repbook");
  const editHref = await page
    .locator('a[href^="/activity/"][href*="/edit"]')
    .first()
    .getAttribute("href");
  expect(editHref, "The seeded activity edit route was missing.").toBeTruthy();
  await visitRenderedDocument(page, editHref!);
  await expect(page).toHaveTitle("Activity record · Repbook");

  await visitRenderedDocument(page, "/archive");
  const deleteHref = await page
    .locator('a[href^="/archive/"][href$="/delete"]')
    .first()
    .getAttribute("href");
  expect(
    deleteHref,
    "The seeded permanent-delete preview route was missing."
  ).toBeTruthy();
  await visitRenderedDocument(page, deleteHref!);
  await expect(page).toHaveTitle("Archive · Repbook");
  const reauthRoute = `${deleteHref}/reauth`;
  const reauthResponse = await page.request.get(reauthRoute, {
    maxRedirects: 0,
  });
  expect([303, 307]).toContain(reauthResponse.status());
  expect(new URL(reauthResponse.headers().location!, baseURL).pathname).toBe(
    new URL(deleteHref!, baseURL).pathname
  );
  policyNonce(
    reauthResponse.headers()["content-security-policy"] ?? "",
    reauthRoute
  );

  await visitRenderedDocument(page, "/recovery");
  await expect(
    page.getByRole("button", {
      name: "Inspect historical consequence graph",
      exact: true,
    }),
  ).toBeVisible();
  await visitRenderedDocument(page, "/recovery/semantic-consequences");
  await expect(
    page.getByRole("heading", { name: "Historical consequence graph" }),
  ).toBeVisible();
  await expect(
    page.getByText("No mutation authorized", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Repair assessment", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Provably repairable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Exact repair eligibility", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Current catalog metadata and ordinary record versions are not performed-time proof. Rows without immutable evidence stay unchanged and explicitly unknown.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "If a later reviewed repair proves that a Program consequence needs correction, it must be published as a new user-reviewed proposal.",
      { exact: true },
    ),
  ).toBeVisible();

  await visitRenderedDocument(page, "/recovery");
  const restoreHref = await page
    .locator('a[href^="/recovery/"][href$="/restore"]')
    .first()
    .getAttribute("href");
  expect(restoreHref, "The seeded snapshot restore route was missing.").toBeTruthy();
  await visitRenderedDocument(page, restoreHref!);
  await expect(page).toHaveTitle("Recovery · Repbook");
  await expect(
    page.getByText("Another snapshot operation is still running", {
      exact: true,
    })
  ).toBeVisible();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as {
    name: string;
    short_name: string;
    description: string;
    display: string;
    start_url: string;
    icons: Array<{ src: string; sizes: string }>;
  };
  expect(manifest).toMatchObject({
    name: "Repbook Workout Tracker",
    short_name: "Repbook",
    description:
      "A private training record that keeps Program intent, performed work, recorded evidence, and reviewed change connected.",
    display: "standalone",
    start_url: "/today",
  });
  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.status(), `${icon.src} was not installable`).toBe(200);
    expect(iconResponse.headers()["content-type"]).toBe("image/png");
  }

  expect(policyViolations).toEqual([]);
  expect(browserErrors).toEqual([]);
});
