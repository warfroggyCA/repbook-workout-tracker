import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";
import { observeGauntletPageErrors } from "../helpers/v2-gauntlet-a-errors";

const EMAIL = "owner@example.com";

async function waitForReactHandler(locator: Locator) {
  await expect.poll(async () => {
    if ((await locator.count()) !== 1) return false;
    return locator.evaluate((element) => {
      const propsKey = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith("__reactProps$"),
      );
      if (!propsKey) return false;
      const props = (element as unknown as Record<string, unknown>)[propsKey];
      return typeof props === "object" && props !== null &&
        typeof (props as { onClick?: unknown }).onClick === "function";
    });
  }, { timeout: 30_000 }).toBe(true);
}

async function installClipboardHarness(
  page: Page,
  mode: "copy" | "deny" = "copy",
) {
  await page.addInitScript(({ clipboardMode }) => {
    class TestClipboardItem {
      private readonly values: Record<string, Blob | Promise<Blob>>;

      constructor(values: Record<string, Blob | Promise<Blob>>) {
        this.values = values;
      }

      async getType(type: string) {
        const value = await this.values[type];
        if (!value) throw new Error(`Missing clipboard type ${type}.`);
        return value;
      }
    }

    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: TestClipboardItem[]) => {
          if (clipboardMode === "deny") {
            throw new DOMException(
              "Clipboard permission denied.",
              "NotAllowedError",
            );
          }
          const blob = await items[0]!.getType("text/plain");
          (window as unknown as { __repbookClipboard?: string })
            .__repbookClipboard = await blob.text();
        },
        writeText: async (value: string) => {
          if (clipboardMode === "deny") {
            throw new DOMException(
              "Clipboard permission denied.",
              "NotAllowedError",
            );
          }
          (window as unknown as { __repbookClipboard?: string })
            .__repbookClipboard = value;
        },
      },
    });
  }, { clipboardMode: mode });
}

async function signIn(page: Page) {
  await installNextDevelopmentRefreshControl(page);
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
}

test("keeps portable facts, AI packages, support diagnostics, Review, and Coach visibly separate", async ({
  browserName,
  page,
}, testInfo) => {
  await installClipboardHarness(page);
  await signIn(page);
  const pageErrors = observeGauntletPageErrors(page, browserName);
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (host !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();

  await page.goto("/export");
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.dataset.fontSize)
  ).toBe("extra-large");
  await expect(
    page.getByRole("heading", { name: "Downloads & backup" }),
  ).toBeVisible();
  await expect(page.getByText("AI training report", { exact: true })).toBeVisible();
  await expect(page.getByText("Training Brief", { exact: true })).toBeVisible();
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Back up all Repbook data", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Versioned analysis package", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText("Support bundle", { exact: true })).not.toBeVisible();
  await expect(
    page.getByText("Spreadsheet data (CSV)", { exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText(/never sent anywhere by Repbook/i)).toBeVisible();
  const completeReportButton = page.getByRole("button", {
    name: "Prepare AI brief for copying",
    exact: true,
  });
  expect((await completeReportButton.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
  await completeReportButton.click();
  await expect(page.getByText(/AI brief ready/)).toBeVisible();
  expect(await page.getByRole("link", { name: "Download complete report", exact: true }).evaluate((link) => link.scrollWidth <= link.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("complete-report-ready.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Copy AI brief", exact: true }).click();
  await expect(
    page.getByText("AI brief copied to your clipboard.", { exact: true }),
  ).toBeVisible();
  const copiedReport = await page.evaluate(
    () => (window as unknown as { __repbookClipboard?: string }).__repbookClipboard,
  );
  expect(copiedReport).toContain("# Instructions for the language model");
  expect(copiedReport).toContain("# Repbook training record");
  expect(copiedReport).toContain("# AI training brief");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(testInfo.outputPath("synthetic-ai-brief.md"), copiedReport!);
  expect(copiedReport).not.toContain(EMAIL);
  expect(copiedReport).not.toContain("<repbook-retained-source-records>");
  expect(copiedReport).toContain("Current Program — future intent");
  expect(copiedReport).toContain("Technical/app issues");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
  const trainingBriefDownload = page.getByRole("button", {
    name: "Download training brief",
    exact: true,
  });
  await trainingBriefDownload.scrollIntoViewIfNeeded();
  await trainingBriefDownload.click({ trial: true });

  const advanced = page.locator("details").filter({
    has: page.getByText("Advanced exports", { exact: true }),
  });
  await advanced.getByText("Advanced exports", { exact: true }).click();
  await expect(
    page.getByText("Versioned analysis package", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Support bundle", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Spreadsheet data (CSV)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/never uploads it automatically/i)).toBeVisible();

  await page.goto("/history?range=all");
  await page.getByRole("button", { name: "More History actions" }).click();
  await page
    .getByRole("link", { name: "Prepare training brief", exact: true })
    .click();
  await expect(page).toHaveURL(/\/export\?briefRange=all#training-brief$/);
  await expect(page.getByLabel("Period to summarize")).toHaveValue("12");
  await expect(page.getByText(/The summary starts with the last 12 weeks/i)).toBeVisible();

  await page.goto("/export?briefRange=6m#training-brief");
  await expect(page.getByLabel("Period to summarize")).toHaveValue("26");
  await expect(page.getByText(/The summary starts with the last 12 weeks/i)).toHaveCount(0);
  const formValues = await page
    .locator('form[action="/api/export/markdown"]')
    .evaluate((form) =>
      Object.fromEntries(new FormData(form as HTMLFormElement)),
    );
  expect(formValues).toEqual({ weeks: "26", download: "1" });

  await advanced.getByText("Advanced exports", { exact: true }).click();

  await page.getByText("Prepare analysis package", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Analysis package" }),
  ).toBeVisible();
  await expect(page.getByText(/Repbook does not send it anywhere/i)).toBeVisible();

  await page.goto("/export/support");
  await expect(
    page.getByRole("heading", { name: "Support bundle" }),
  ).toBeVisible();
  await expect(page.getByText(/never sends the bundle for you/i)).toBeVisible();
  await expect(
    page.getByText(/Nothing is uploaded or sent to an AI/i),
  ).toBeVisible();

  await page.goto("/coach");
  await expect(
    page.getByRole("heading", { name: "Coach" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Your training, explained simply/i),
  ).toBeVisible();
  await expect(page.getByText("Coaching tools", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Ask Live Coach while you train/i),
  ).toBeVisible();

  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default 115%/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();

  expect(externalRequests).toEqual([]);
  await pageErrors.expectNoUnexpected();
});

test("reports clipboard denial, keeps the prepared copy, and recovers from preparation failures", async ({ page }) => {
  await installClipboardHarness(page, "deny");
  await signIn(page);
  await page.route("**/api/export/llm-report?view=brief", (route) => route.fulfill({
    contentType: "text/markdown", body: "# Synthetic complete report",
  }));
  await page.goto("/export");
  await page.getByRole("button", { name: "Prepare AI brief for copying", exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy AI brief", exact: true });
  await copy.click();
  await expect(page.locator("p[role=alert]")).toContainText("Copying was not confirmed");
  await expect(copy).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        if (!navigator.userActivation.isActive) throw new Error("Not in a tap");
        (window as unknown as { __repbookClipboard: string }).__repbookClipboard = text;
      },
    } });
  });
  await copy.click();
  await expect(page.getByText("AI brief copied to your clipboard.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __repbookClipboard: string }).__repbookClipboard))
    .toBe("# Synthetic complete report");

  await page.route("**/api/export/llm-report?view=brief", (route) => route.fulfill({ status: 500, body: "private error" }));
  await page.getByRole("button", { name: "Prepare AI brief for copying", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("The report could not be prepared. Try again.");
});

test("keeps oversized reports out of the clipboard and offers the complete download", async ({ page }) => {
  await installClipboardHarness(page);
  await signIn(page);
  await page.route("**/api/export/llm-report?view=brief", (route) => route.fulfill({
    contentType: "text/markdown", body: "x".repeat(1024 * 1024 + 1),
  }));
  await page.goto("/export");
  await page.getByRole("button", { name: "Prepare AI brief for copying", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText("clipboard size limit");
  expect(await page.evaluate(() => (window as unknown as { __repbookClipboard?: string }).__repbookClipboard)).toBeUndefined();
  const download = page.getByRole("link", { name: "Download complete report", exact: true });
  await expect(download).toHaveAttribute("href", "/api/export/llm-report?download=1");
  await page.unroute("**/api/export/llm-report?view=brief");
  // The real export lease has a five-second account cooldown. This test shares
  // the suite's synthetic owner with the earlier actual-report preparation.
  await page.waitForTimeout(5_100);
  const attachmentResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/export/llm-report" &&
    new URL(response.url()).searchParams.get("download") === "1",
  );
  const downloaded = page.waitForEvent("download", { timeout: 30_000 });
  await download.click();
  const response = await attachmentResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/octet-stream");
  expect(response.headers()["content-disposition"]).toMatch(/^attachment;/);
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/^repbook-complete-report-.*\.md$/);
  expect(await file.failure()).toBeNull();
  const path = await file.path();
  const { readFile } = await import("node:fs/promises");
  const contents = await readFile(path!, "utf8");
  expect(contents).toContain("# Repbook training record");
  expect(contents).toContain("</repbook-retained-source-records>");

});

test("times out a stalled report and permits retry without a duplicate request", async ({ page }) => {
  await installClipboardHarness(page);
  await signIn(page);
  await page.goto("/export");
  await page.clock.install();
  let requests = 0;
  await page.route("**/api/export/llm-report?view=brief", () => { requests += 1; });
  const prepare = page.getByRole("button", { name: "Prepare AI brief for copying", exact: true });
  await prepare.click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole("button", { name: "Preparing report…", exact: true })).toBeDisabled();
  await page.clock.fastForward(30_001);
  await expect(page.locator("p[role=alert]")).toContainText("took too long");
  await expect(prepare).toBeEnabled();
  expect(requests).toBe(1);
  await page.unroute("**/api/export/llm-report?view=brief");
  await page.route("**/api/export/llm-report?view=brief", (route) => route.fulfill({ contentType: "text/markdown", body: "# Retry complete" }));
  await prepare.click();
  await expect(page.getByRole("button", { name: "Copy AI brief", exact: true })).toBeEnabled();
});
