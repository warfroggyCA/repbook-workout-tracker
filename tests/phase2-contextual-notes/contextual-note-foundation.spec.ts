import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BA_WORKOUT_EMAIL } from "../fixtures/ba-workout-contract";
import {
  waitForHydratedReactHandler,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const runId = process.env.PHASE2_RUN_ID ?? `phase2-local-${Date.now()}`;
const evidenceDirectory = resolve(
  "output/playwright/phase2-contextual-notes",
  runId,
  "evidence",
);

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function chooseAppSize(page: Page, name: RegExp) {
  await page.goto("/settings");
  const option = page.getByRole("radio", { name });
  if ((await option.getAttribute("aria-checked")) !== "true") {
    await waitForHydratedReactHandler(option);
    await option.click();
    await expect(page.getByText("Saved to your profile.", { exact: true })).toBeVisible();
  }
}

async function assertLayout(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
  const clipped = await page.locator("button:visible, a:visible").evaluateAll(
    (elements) => elements.filter((element) =>
      element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
    ).map((element) => (element.textContent ?? element.getAttribute("aria-label") ?? "").trim()),
  );
  expect(clipped).toEqual([]);
}

async function openComposer(page: Page) {
  const workoutTrigger = page.getByTestId("contextual-note-trigger-workout");
  const trigger = await workoutTrigger.count() > 0
    ? workoutTrigger.first()
    : page.getByTestId("contextual-note-trigger");
  await waitForHydratedReactHandler(trigger);
  await trigger.click();
  await expect(page.getByRole("heading", { name: "Add a training note" })).toBeVisible();
}

test("keeps contextual observations explicit, durable, private when chosen, and safe through retry", async ({
  page,
  context,
}) => {
  const unexpected: string[] = [];
  let offlineExpected = false;
  page.on("console", (message) => {
    if (message.type() === "error" && !offlineExpected) unexpected.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    if (offlineExpected && error.message === "Load failed") return;
    if (
      error.message === "Load failed" &&
      new URL(page.url()).pathname === "/archive"
    ) return;
    if (
      /[?&]_rsc=/.test(error.message) &&
      error.message.endsWith("due to access control checks.")
    ) return;
    unexpected.push(`page: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const reason = request.failure()?.errorText ?? "unknown";
    if (offlineExpected && /INTERNET_DISCONNECTED|cancelled/i.test(reason)) return;
    const expectedRscCancellation =
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      url.searchParams.has("_rsc") &&
      request.headers().rsc === "1" &&
      /ABORTED|cancelled/i.test(reason);
    const expectedActionCancellation =
      request.method() === "POST" &&
      !request.isNavigationRequest() &&
      Boolean(request.headers()["next-action"]) &&
      ["/sign-in", "/today", "/session", "/history"].some(
        (pathname) => url.pathname === pathname || url.pathname.startsWith(`${pathname}/`),
      ) &&
      /ABORTED|cancelled/i.test(reason);
    if (expectedRscCancellation || expectedActionCancellation) return;
    unexpected.push(`request: ${request.method()} ${url.pathname} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !offlineExpected) {
      unexpected.push(`response: ${response.status()} ${new URL(response.url()).pathname}`);
    }
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);

  const sizes = [
    { name: /Compact 100%/, key: "compact" },
    { name: /Default 115%/, key: "default" },
    { name: /Large 130%/, key: "large" },
    { name: /Extra large 145%/, key: "extra-large" },
  ];
  for (const size of sizes) {
    await chooseAppSize(page, size.name);
    await page.goto("/program");
    await openComposer(page);
    await expect(page.locator("html")).toHaveAttribute("data-font-size", size.key);
    await expect(page.getByLabel("Attach to")).toContainText("Program day");
    await expect(page.getByLabel("Attach to")).toContainText("Program item");
    await assertLayout(page);
    await page.screenshot({
      path: resolve(evidenceDirectory, `program-composer-375-${size.key}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close · keep draft", exact: true }).click();
  }

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/today");
  await assertLayout(page);
  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const workoutPath = new URL(page.url()).pathname;
  const workoutHeading = page.getByRole("heading", { level: 1 });
  await expect(workoutHeading).toBeVisible();

  await openComposer(page);
  const attachment = page.getByLabel("Attach to");
  await expect(attachment).toContainText(/warm-up|set|Entire workout/);
  const workoutAttachmentValue = await attachment
    .locator("option")
    .filter({ hasText: "Entire workout" })
    .getAttribute("value");
  expect(workoutAttachmentValue).not.toBeNull();
  await attachment.selectOption(workoutAttachmentValue!, { timeout: 5_000 });
  await page.getByLabel("Your observation").fill("Shoulder felt stable after the longer warm-up.");
  await assertLayout(page);
  await page.screenshot({
    path: resolve(evidenceDirectory, "active-workout-composer-320-extra-large.png"),
    fullPage: true,
  });

  offlineExpected = true;
  await context.setOffline(true);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Note waiting to save", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(workoutPath);
  await expect(workoutHeading).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDirectory, "offline-note-retained-320-extra-large.png"),
    fullPage: true,
  });

  await context.setOffline(false);
  await expect(page.getByText("Note waiting to save", { exact: true })).toHaveCount(0);
  offlineExpected = false;

  await page.getByRole("button", { name: "Finish", exact: true }).click();
  const saveWorkout = page.getByRole("button", { name: "Save workout", exact: true });
  await waitForHydratedReactHandler(saveWorkout);
  await saveWorkout.click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByRole("heading", { name: "Training notes" })).toBeVisible();
  await expect(page.getByText("Shoulder felt stable after the longer warm-up.")).toBeVisible();

  await openComposer(page);
  await page.getByLabel("Your observation").fill("Private recovery detail for my own record.");
  const coachVisibility = page.getByRole("checkbox");
  await coachVisibility.click();
  await expect(coachVisibility).not.toBeChecked();
  await expect(page.getByLabel("Private note")).toBeVisible();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText(/Note waiting to save|Saving note/)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Private recovery detail for my own record.")).toBeVisible();
  await expect(page.getByText(/Private · revision 1/)).toBeVisible();
  await assertLayout(page);
  await page.screenshot({
    path: resolve(evidenceDirectory, "history-note-placement-320-extra-large.png"),
    fullPage: true,
  });

  const reviewNotes = page.getByRole("button", { name: "Review notes", exact: true });
  await waitForHydratedReactHandler(reviewNotes);
  await reviewNotes.click();
  await expect(page.getByRole("heading", { name: "Review saved training notes" })).toBeVisible();
  const manager = page.getByLabel("Review saved training notes");
  const privateNote = manager.locator("li").filter({ hasText: "Private recovery detail for my own record." });
  await privateNote.getByRole("button", { name: "Edit text or privacy" }).click();
  await page.getByLabel("Your observation").fill("Private recovery detail, corrected after review.");
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(manager.getByText("Private recovery detail, corrected after review.")).toBeVisible();
  await expect(manager.getByText(/Private · revision 2/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await manager.locator("li").filter({ hasText: "Private recovery detail, corrected after review." })
    .getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByText("Note archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review or undo", exact: true })).toBeVisible();
  await assertLayout(page);
  await page.screenshot({
    path: resolve(evidenceDirectory, "saved-note-edit-archive-320-extra-large.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Review or undo", exact: true }).click();
  await expect(page).toHaveURL(/\/archive#operation-[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Archive", exact: true })).toBeVisible();
  const archivedNote = page.locator("[id^='operation-']").filter({ hasText: "Archived one training observation." });
  await expect(archivedNote.getByRole("button", { name: "Restore", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/program");
  await openComposer(page);
  const addNoteBox = await page.getByRole("button", { name: "Save note", exact: true }).boundingBox();
  expect(addNoteBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Attach to").focus();
  await expect(page.getByLabel("Attach to")).toBeFocused();
  await assertLayout(page);
  await page.screenshot({
    path: resolve(evidenceDirectory, "program-composer-keyboard-1440-extra-large.png"),
    fullPage: true,
  });
  const retainedAttachment = await page.getByLabel("Attach to").inputValue();
  await page.getByLabel("Your observation").fill("Program draft must keep this original context.");
  await page.getByRole("button", { name: "Close · keep draft", exact: true }).click();
  await page.locator('a[href="/today"]').first().click();
  await expect(page).toHaveURL(/\/today$/);
  await openComposer(page);
  await expect(page.getByText("Draft kept with its original context", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Your observation")).toHaveValue(
    "Program draft must keep this original context.",
  );
  await expect(page.getByLabel("Attach to")).toHaveValue(retainedAttachment);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();

  expect(unexpected).toEqual([]);
  await writeFile(
    resolve(evidenceDirectory, "browser-observations.json"),
    `${JSON.stringify({ unexpected }, null, 2)}\n`,
    { flag: "wx" },
  );
});

test("requires a second explicit review before simulated text becomes a real note", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.goto("/simulation");
  const launch = page.getByRole("button", { name: /Start .* simulation/ }).first();
  await waitForHydratedReactHandler(launch);
  await launch.click();
  await expect(page).toHaveURL(/\/simulation\/sim_workspace_[0-9a-f-]+$/);
  const startWorkout = page.getByRole("button", { name: /Start .* simulation/ });
  await waitForHydratedReactHandler(startWorkout);
  await startWorkout.click();
  const localNote = page.getByLabel("This step only");
  await localNote.fill("Rehearsal text awaiting deliberate real-world review.");
  const saveSimulatedNote = page.getByRole("button", { name: "Save simulated step note" });
  await waitForHydratedReactHandler(saveSimulatedNote);
  await saveSimulatedNote.click();
  await expect(page.getByRole("button", { name: "Review as real training note" }).first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Review as real training note" }).first().click();
  await expect(page).toHaveURL(/\/today\?contextualNote=simulation$/);
  await expect(page.getByRole("heading", { name: "Add a training note" })).toBeVisible();
  await expect(page.getByLabel("Your observation")).toHaveValue(
    "Rehearsal text awaiting deliberate real-world review.",
  );
  await expect(page.getByText("Simulation remains separate", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close · keep draft", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Add a training note" })).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDirectory, "simulation-transfer-still-awaiting-confirmation.png"),
    fullPage: true,
  });
});
