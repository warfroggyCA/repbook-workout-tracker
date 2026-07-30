import { expect, type BrowserContext, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

const localAuthSecret = "local-e2e-secret-not-used-outside-this-process";

export async function installLocalAuthSession(
  context: BrowserContext,
  baseURL: string,
  email = "owner@example.com"
) {
  const cookieName = "authjs.session-token";
  const value = await encode({
    token: {
      email,
      name: "Optimized route verifier",
      sub: `optimized-route-${email}`,
    },
    secret: localAuthSecret,
    salt: cookieName,
    maxAge: 8 * 60 * 60,
  });
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: cookieName,
      value,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
  ]);
}

export function policyNonce(policy: string, route: string) {
  expect(policy, `${route} did not receive a CSP`).toContain("'strict-dynamic'");
  expect(policy, `${route} allowed inline script`).not.toMatch(
    /script-src[^;]*'unsafe-inline'/
  );
  expect(policy, `${route} allowed evaluated script`).not.toMatch(
    /script-src[^;]*'unsafe-eval'/
  );
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce, `${route} did not receive a nonce`).toBeTruthy();
  return nonce!;
}

export async function visitRenderedDocument(page: Page, route: string) {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  expect(response, `${route} did not return a document`).not.toBeNull();
  expect(
    response!.status(),
    `${route} returned an unsuccessful document`
  ).toBeLessThan(400);
  if (route !== "/" && route !== "/setup") {
    const requestedPathname = new URL(route, response!.url()).pathname;
    expect(
      new URL(response!.url()).pathname,
      `${route} redirected to a different page`
    ).toBe(requestedPathname);
  }
  await expect(
    page.locator("body"),
    `${route} did not render a visible body`
  ).toBeVisible();
  const nonce = policyNonce(
    response!.headers()["content-security-policy"] ?? "",
    route
  );
  await expect
    .poll(
      async () => {
        const nonces = await page.locator("script").evaluateAll((scripts) =>
          scripts.map((script) => (script as HTMLScriptElement).nonce)
        );
        return (
          nonces.length > 0 &&
          nonces.every((scriptNonce) => scriptNonce === nonce)
        );
      },
      { message: `${route} did not attach the response nonce to framework scripts` }
    )
    .toBe(true);
  return response!;
}
