import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { installLocalAuthSession } from "../helpers/browser-security";
// Next ships this production action encoder without a public declaration file.
// @ts-expect-error -- the runtime export is verified by the optimized build test.
import { encodeReply } from "next/dist/compiled/react-server-dom-turbopack/client.js";

test("uses a deployed action reference and returns a friendly saved-operation recovery outcome", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/sign-in");

  const origin = new URL(page.url()).origin;
  const recoveryResponse = await page.request.post(
    `${origin}/api/live-coach/messages`,
    {
      data: {},
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
    }
  );
  expect(recoveryResponse.status()).toBe(401);
  expect(recoveryResponse.headers()["cache-control"]).toBe(
    "private, no-store"
  );
  expect(recoveryResponse.headers()["x-content-type-options"]).toBe(
    "nosniff"
  );
  const recovery = (await recoveryResponse.json()) as unknown;
  expect(recovery).toEqual({
    ok: false,
    reason: "Sign in again, then retry this saved Coach message.",
  });
  expect(JSON.stringify(recovery)).not.toMatch(
    /digest|an error occurred|server error/i
  );

  const githubButton = page.getByRole("button", {
    name: "Sign in with GitHub",
  });
  await expect(githubButton).toBeVisible();
  const actionInput = githubButton
    .locator("xpath=ancestor::form")
    .locator('input[type="hidden"][name^="$ACTION_ID_"]');
  const actionFieldName = await actionInput.getAttribute("name");
  expect(actionFieldName).toMatch(/^\$ACTION_ID_[a-f0-9]{32,128}$/);
  const actionId = actionFieldName!.slice("$ACTION_ID_".length);

  await page.route(
    "https://github.com/login/oauth/authorize**",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<main>OAuth handoff verified</main>",
      });
    }
  );
  const actionResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.request().headers()["next-action"] === actionId
  );
  await githubButton.click();
  const actionResponse = await actionResponsePromise;

  expect(actionResponse.status()).toBe(303);
  expect(actionResponse.request().headers()["next-action"]).toBe(actionId);
  expect(actionResponse.headers()["x-action-redirect"]).toMatch(
    /^https:\/\/github\.com\/login\/oauth\/authorize\?.*;push$/
  );
  await expect(page).toHaveURL(
    /^https:\/\/github\.com\/login\/oauth\/authorize/
  );
  await expect(page.getByText("OAuth handoff verified")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

if (!process.env.PLAYWRIGHT_PRODUCTION_BASE_URL) {
  test("shows a crafted named action failure from the optimized build", async ({
    page,
    context,
  }) => {
    await page.goto("/sign-in");
    const origin = new URL(page.url()).origin;
    await installLocalAuthSession(context, origin);
    await page.goto("/today");

    const resume = page.getByRole("button", {
      name: "Resume workout",
      exact: true,
    });
    const start = page.getByRole("button", {
      name: "Train as planned",
      exact: true,
    });
    await expect
      .poll(async () => {
        if ((await resume.count()) > 0) return "resume";
        if ((await start.count()) > 0) return "start";
        return "loading";
      })
      .toMatch(/^(resume|start)$/);
    await ((await resume.count()) > 0 ? resume : start).click();
    await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);

    const stalePage = await context.newPage();
    await stalePage.goto(page.url());
    const staleNextSet = stalePage.getByTestId("current-exercise-card");
    await staleNextSet
      .locator("details", { hasText: "More for this exercise" })
      .locator(":scope > summary")
      .click();
    const staleAlternatives = staleNextSet.getByRole("button", {
      name: "View alternatives",
      exact: true,
    });
    await expect(staleAlternatives).toBeVisible();

    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page
      .getByRole("button", { name: "Discard workout", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: /Discard .*\?$/ })
      .getByRole("button", { name: "Confirm discard", exact: true })
      .click();
    await expect(page).toHaveURL(/\/today$/);

    await staleAlternatives.click();
    await expect(
      stalePage.getByText("Only an active workout can be changed.", {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      stalePage.getByText(/digest|an error occurred|server error/i)
    ).toHaveCount(0);
  });

  test("returns a structured invalid set-save outcome from the matching optimized build", async ({
    page,
  }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto("/sign-in");
    const manifest = JSON.parse(
      await readFile(".next/server/server-reference-manifest.json", "utf8")
    ) as {
      node: Record<
        string,
        {
          workers: Record<
            string,
            { exportedName: string; filename: string }
          >;
        }
      >;
    };
    const actionId = Object.entries(manifest.node).find(([, action]) =>
      Object.values(action.workers).some(
        (worker) =>
          worker.exportedName === "logSet" &&
          worker.filename.endsWith("src/app/actions/sessions.ts")
      )
    )?.[0];
    expect(actionId).toBeTruthy();

    const body = await encodeReply([
      {
        sessionExerciseId: "not-a-uuid",
        setNo: 1,
        weight: 100,
        weightUnit: "lb",
        reps: 8,
        rpe: null,
        note: null,
        clientKey: "production-browser-check",
      },
    ]);
    expect(typeof body).toBe("string");

    const result = await page.evaluate(
      async ({ id, encodedBody }) => {
        const response = await fetch("/today", {
          method: "POST",
          headers: {
            Accept: "text/x-component",
            "Content-Type": "text/plain;charset=UTF-8",
            "Next-Action": id,
          },
          body: encodedBody,
        });
        return { status: response.status, text: await response.text() };
      },
      { id: actionId!, encodedBody: body as string }
    );

    expect(result.status).toBe(200);
    expect(result.text).toContain('"outcome":"invalid"');
    expect(result.text).not.toMatch(/digest|an error occurred|server error/i);
    expect(browserErrors).toEqual([]);
  });
}
