import { expect, test } from "@playwright/test";
import { policyNonce } from "../helpers/browser-security";

test("enforces reviewed browser protections across the optimized app", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto("/sign-in");
  expect(response).not.toBeNull();
  const headers = response!.headers();
  const signInPolicy = headers["content-security-policy"];
  expect(signInPolicy).toContain("default-src 'self'");
  expect(signInPolicy).toContain("frame-ancestors 'none'");
  expect(signInPolicy).toContain("'strict-dynamic'");
  expect(signInPolicy).toContain("script-src-attr 'none'");
  expect(signInPolicy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(signInPolicy).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  expect(signInPolicy).toMatch(/script-src[^;]*'nonce-[^']+'/);
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  await expect(page).toHaveTitle("Sign in · Repbook");
  await expect(page.getByText("Repbook", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Private training record", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Plan. Train. Review.", { exact: true })).toBeVisible();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json"
  );
  const manifest = (await manifestResponse.json()) as {
    name: string;
    short_name: string;
    description: string;
    background_color: string;
    theme_color: string;
    display: string;
    start_url: string;
    icons: Array<{ src: string; sizes: string }>;
  };
  expect(manifest).toMatchObject({
    name: "Repbook Workout Tracker",
    short_name: "Repbook",
    description:
      "A private training record that keeps Program intent, performed work, recorded evidence, and reviewed change connected.",
    background_color: "#f7f8fb",
    theme_color: "#2456b8",
  });
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/today");
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: "/icon-192.png", sizes: "192x192" }),
      expect.objectContaining({ src: "/icon-512.png", sizes: "512x512" }),
    ])
  );
  for (const icon of ["/icon-192.png", "/icon-512.png"]) {
    const iconResponse = await page.request.get(icon);
    expect(iconResponse.status()).toBe(200);
    expect(iconResponse.headers()["content-type"]).toBe("image/png");
  }

  const routes = [
    "/today",
    "/history",
    "/coach",
    "/program",
    "/program/import",
    "/settings",
    "/settings/audit",
    "/settings/equipment",
    "/settings/setup",
    "/settings/setup/profile",
    "/export",
    "/archive",
    "/recovery",
    "/recovery/semantic-consequences",
    "/recovery/versions",
    "/activity/new",
  ];
  const nonces = new Set<string>();
  for (const route of routes) {
    const routeResponse = await page.request.get(route, { maxRedirects: 0 });
    expect([303, 307]).toContain(routeResponse.status());
    expect(routeResponse.headers().location).toContain("/sign-in");
    const policy = routeResponse.headers()["content-security-policy"];
    nonces.add(policyNonce(policy, route));
  }
  expect(nonces.size).toBe(routes.length);
  expect(browserErrors).toEqual([]);
});

test("keeps sign-in controls reachable on supported narrow layouts", async ({
  page,
}) => {
  for (const layout of [
    { width: 390, height: 844, fontSize: "default" },
    { width: 320, height: 700, fontSize: "extra-large" },
  ] as const) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.goto("/sign-in");
    await page.evaluate((fontSize) => {
      document.documentElement.dataset.fontSize = fontSize;
    }, layout.fontSize);

    const signIn = page.getByRole("button", {
      name: "Sign in with GitHub",
    });
    await expect(signIn).toBeVisible();
    const controls = page.locator("form button:visible, form input:visible");
    for (let index = 0; index < (await controls.count()); index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await signIn.focus();
    await expect(signIn).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      )
    ).toBeLessThanOrEqual(1);
  }
});
