import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BA_ROUTINE_CHANGE_EMAIL,
  BA_ROUTINE_CHANGE_ORACLE,
  BA_ROUTINE_CHANGE_REQUEST,
  BA_ROUTINE_CHANGE_SEMANTIC_DIGEST,
} from "../fixtures/ba-routine-change-contract";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("allowlisted email").fill(BA_ROUTINE_CHANGE_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function publishExactBaRoutineChange(page: Page) {
  await page.goto("/program/edit");
  await expect(page.getByRole("status")).toContainText("All changes saved");
  await page.getByLabel("Update current Program").check();
  await page.getByLabel("What should change?").fill(BA_ROUTINE_CHANGE_REQUEST);
  await page.getByRole("button", { name: "Compare and propose changes", exact: true }).click();
  await expect(page.getByText("Proposal ready to review", { exact: true })).toBeVisible();
  await expect(page.getByText(/0 need a decision/)).toBeVisible();
  await page.getByRole("button", { name: "Apply selected changes", exact: true }).click();
  await expect(page.getByText("Proposal applied to the draft", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("All changes saved");
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /Compare with current Program|Review changes/ }).first().click();
  await expect(page.getByRole("heading", { name: "Changes you made", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Activate new version", exact: true }).click();
  await expect(page.getByText(/Version 2 is now current/)).toBeVisible();
  await page.goto("/program");
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Day 2", exact: true }).click();
  await expect(page.getByText(/A: Cable Rear Delt Fly \+ Zottman Curl \+ Overhead Cable Triceps Extension/)).toBeVisible();
  await page.getByRole("tab", { name: "Day 3", exact: true }).click();
  await expect(page.getByText(/A: Overhead Cable Triceps Extension \+ EZ-Bar Curl/)).toBeVisible();
}

async function mutationState(page: Page) {
  const response = await page.request.get("/api/acceptance/simulation-state");
  expect(
    response.ok(),
    `The guarded simulation-state endpoint returned HTTP ${response.status()}.`,
  ).toBe(true);
  const body = (await response.json()) as {
    status: string;
    state: { digest: string; counts: Record<string, number> };
  };
  expect(body.status).toBe("ok");
  expect(body.state.digest).toMatch(/^[a-f0-9]{64}$/);
  return body.state;
}

async function nonSimulationStorage(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => !key.startsWith("workout-tracker:simulation:v1:"))
        .sort()
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
}

async function settleRest(page: Page, mode: "advance" | "skip" = "advance") {
  const rest = page.getByRole("region", { name: "Simulated rest" });
  if (!(await rest.isVisible().catch(() => false))) return null;
  const observed = (await rest.textContent()) ?? "";
  const advance = rest.getByRole("button", { name: "Advance rest", exact: true });
  const skip = rest.getByRole("button", { name: "Skip rest", exact: true });
  if (mode === "skip" && await skip.isVisible().catch(() => false)) await skip.click();
  else if (await advance.isVisible().catch(() => false)) await advance.click();
  const continueButton = rest.getByRole("button", { name: "Continue", exact: true });
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click();
  return observed;
}

async function storedSimulationWorkspace(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith("workout-tracker:simulation:v1:"),
    );
    if (!key) throw new Error("The local simulation workspace is missing.");
    return { key, value: localStorage.getItem(key) ?? "" };
  });
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function resolveSimulatedDay(
  page: Page,
  options: {
    expectEz?: boolean;
    exerciseBranches?: boolean;
    groupScreenshotPath?: string;
    ezScreenshotPath?: string;
  } = {},
) {
  let usedSkip = false;
  let usedSubstitution = false;
  let usedPain = false;
  let usedCorrection = false;
  let usedNotes = false;
  let usedStorageFailure = false;
  let usedKeyboard = false;
  let capturedGroup = false;
  let capturedEz = false;
  let restCount = 0;
  let sawEz = false;
  let safety = 0;
  const headings: string[] = [];
  const groupPositions: string[] = [];
  const rests: string[] = [];

  while (await page.locator('section[aria-labelledby="current-simulation-step"]').count()) {
    safety += 1;
    expect(safety).toBeLessThan(80);
    const settled = await settleRest(page, restCount++ % 2 === 0 ? "advance" : "skip");
    if (settled) rests.push(settled);
    const current = page.locator('section[aria-labelledby="current-simulation-step"]');
    if (!(await current.count())) break;
    const heading = (await current.getByRole("heading", { level: 2 }).textContent()) ?? "";
    if (headings.at(-1) !== heading) headings.push(heading);
    const groupPosition = current.getByText(/Group round \d+ · member \d+/);
    if (await groupPosition.isVisible().catch(() => false)) {
      const position = (await groupPosition.textContent()) ?? "";
      if (groupPositions.at(-1) !== position) groupPositions.push(position);
      if (options.groupScreenshotPath && !capturedGroup) {
        await groupPosition.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await page.screenshot({ path: options.groupScreenshotPath });
        capturedGroup = true;
      }
    }

    if (/EZ-Bar Curl/i.test(heading)) {
      sawEz = true;
      await expect(current).toContainText("18 lb");
      if (options.ezScreenshotPath && !capturedEz) {
        await current.getByRole("heading", { level: 2 }).evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await page.screenshot({ path: options.ezScreenshotPath });
        capturedEz = true;
      }
    }

    if (options.exerciseBranches && !usedSubstitution && /set 1$/i.test(heading)) {
      const choices = current.locator("details");
      await choices.locator("summary").click();
      const substitute = choices.getByLabel("Substitute locally");
      if (await substitute.isVisible().catch(() => false)) {
        const values = await substitute.locator("option").evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
        );
        if (values[0]) {
          await substitute.selectOption(values[0]);
          await choices.getByRole("button", { name: "Undo simulated substitution" }).click();
          usedSubstitution = true;
        }
      }
      if (!usedPain) {
        await current.getByRole("button", { name: "Add simulated pain flag" }).click();
        usedPain = true;
      }
    }

    const equipment = current.getByLabel("Equipment");
    if (await equipment.isVisible().catch(() => false)) {
      const first = await equipment.locator("option").first().getAttribute("value");
      if (first) await equipment.selectOption(first);
    }

    if (!usedSkip && /set 1$/i.test(heading)) {
      await current.getByRole("button", { name: "Skip this simulated step" }).click();
      const restore = page.getByRole("button", { name: /Restore / }).first();
      await expect(restore).toBeVisible();
      await restore.click();
      usedSkip = true;
      continue;
    }

    const log = current.getByRole("button", { name: "Log simulated set", exact: true });
    if (await log.isVisible().catch(() => false)) {
      if (options.exerciseBranches && !usedNotes) {
        await current.getByLabel("This step only").fill("Occurrence rehearsal note");
        await current.getByRole("button", { name: "Save simulated step note", exact: true }).click();
        await current.getByLabel("This simulated exercise").fill("Exercise rehearsal note");
        await current.getByRole("button", { name: "Save simulated exercise note", exact: true }).click();
        usedNotes = true;
      }
      const repsInput = current.getByLabel("Simulated reps");
      await repsInput.fill("8");
      if (options.exerciseBranches && !usedKeyboard) {
        await repsInput.focus();
        await expect(repsInput).toBeFocused();
        await page.keyboard.press("Escape");
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expect(repsInput).not.toBeFocused();
        usedKeyboard = true;
      }
      await current.getByLabel(/Simulated load/).fill(heading.includes("EZ-Bar") ? "38" : "20");
      await current.getByLabel("Set note — simulation only").fill("Simulation only");
      if (options.exerciseBranches && !usedStorageFailure) {
        const progressBefore = await page.locator("main header").textContent();
        await page.evaluate(() => {
          const target = window as typeof window & { __simulationOriginalSetItem?: typeof Storage.prototype.setItem };
          target.__simulationOriginalSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function failSimulationStorage() {
            throw new DOMException("Simulated storage failure", "QuotaExceededError");
          };
        });
        await log.click();
        await expect(
          page.getByRole("alert").filter({ hasText: "not retained" }),
        ).toContainText("not retained");
        expect(await page.locator("main header").textContent()).toBe(progressBefore);
        await page.evaluate(() => {
          const target = window as typeof window & { __simulationOriginalSetItem?: typeof Storage.prototype.setItem };
          if (target.__simulationOriginalSetItem) {
            Storage.prototype.setItem = target.__simulationOriginalSetItem;
            delete target.__simulationOriginalSetItem;
          }
        });
        usedStorageFailure = true;
      }
      await log.click();
      const completedRest = await settleRest(page, restCount++ % 2 === 0 ? "advance" : "skip");
      if (completedRest) rests.push(completedRest);
      if (!usedCorrection) {
        const correction = page.locator("details").filter({ hasText: "Correct latest simulated set" });
        await correction.locator("summary").click();
        await correction.getByRole("button", { name: "Add one rep to latest simulated set" }).click();
        usedCorrection = true;
      }
    } else {
      await current.getByRole("button", { name: "Complete simulated warm-up", exact: true }).click();
    }
  }

  expect(usedSkip).toBe(true);
  if (options.exerciseBranches) {
    expect(usedSubstitution).toBe(true);
    expect(usedPain).toBe(true);
    expect(usedNotes).toBe(true);
    expect(usedStorageFailure).toBe(true);
    expect(usedKeyboard).toBe(true);
  }
  if (options.expectEz) expect(sawEz).toBe(true);
  await page.getByRole("button", { name: "Finish simulated workout", exact: true }).click();
  return { headings, groupPositions, rests };
}

test("rehearses two exact BA-RC workouts locally with zero live mutation", async ({
  page,
  context,
}, testInfo) => {
  await signIn(page);
  await publishExactBaRoutineChange(page);
  expect(BA_ROUTINE_CHANGE_ORACLE).toHaveLength(15);
  expect(BA_ROUTINE_CHANGE_SEMANTIC_DIGEST).toMatch(/^[a-f0-9]{64}$/);

  const beforeDatabase = await mutationState(page);
  await page.goto("/simulation");
  await expect(page.getByText("Simulation — not recorded", { exact: true })).toBeVisible();
  const beforeStorage = await nonSimulationStorage(page);
  await page.screenshot({ path: testInfo.outputPath("01-simulation-launcher.png"), fullPage: true });

  await page.getByRole("button", { name: "Start Day 2 simulation", exact: true }).click();
  await expect(page).toHaveURL(/\/simulation\/sim_workspace_/);
  await expect(page.getByText("Simulation — not recorded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Day 2 simulation", exact: true }).click();

  const mutationRequests: string[] = [];
  const failedRequests: string[] = [];
  const expectedOfflineFailures: string[] = [];
  const expectedNextNavigationCancellations: string[] = [];
  const badResponses: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let offlineWindow = false;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const entry = `${request.method()} ${url.pathname}: ${request.failure()?.errorText ?? "failed"}`;
    if (offlineWindow) expectedOfflineFailures.push(entry);
    else if (
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      url.searchParams.has("_rsc") &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    ) expectedNextNavigationCancellations.push(entry);
    else failedRequests.push(entry);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  const day2 = await resolveSimulatedDay(page, {
    exerciseBranches: true,
    groupScreenshotPath: testInfo.outputPath("02-day2-triset.png"),
  });
  expect(day2.headings.filter((heading) => heading.includes("· set"))).toEqual([
    "Barbell Back Squat · set 1", "Barbell Back Squat · set 2", "Barbell Back Squat · set 3", "Barbell Back Squat · set 4",
    "Romanian Deadlift · set 1", "Romanian Deadlift · set 2", "Romanian Deadlift · set 3",
    "Cable Rear Delt Fly · set 1", "Zottman Curl · set 1", "Overhead Cable Triceps Extension · set 1",
    "Cable Rear Delt Fly · set 2", "Zottman Curl · set 2", "Overhead Cable Triceps Extension · set 2",
  ]);
  expect(day2.groupPositions).toEqual([
    "Group round 1 · member 1", "Group round 1 · member 2", "Group round 1 · member 3",
    "Group round 2 · member 1", "Group round 2 · member 2", "Group round 2 · member 3",
  ]);
  expect(day2.rests.some((value) => value.includes("planned"))).toBe(true);
  await expect(page.getByRole("heading", { name: "Simulated workout complete" })).toBeVisible();
  await page.getByRole("button", { name: "Start Day 3 simulation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Day 3", exact: true })).toBeVisible();

  offlineWindow = true;
  await context.setOffline(true);
  await expect(page.getByText(/Offline — this loaded simulation remains local/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-day3-offline.png") });
  const current = page.locator('section[aria-labelledby="current-simulation-step"]');
  await current.getByRole("button", { name: "Complete simulated warm-up", exact: true }).click();
  await page.getByLabel("Simulation feedback note").fill("Check rehearsal spacing only");
  await page.getByRole("button", { name: "Save local feedback", exact: true }).click();
  const offlineWorkspace = await storedSimulationWorkspace(page);
  await context.setOffline(false);
  offlineWindow = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Day 3", exact: true })).toBeVisible();
  await expect(page.getByText(/1\/.* steps resolved/)).toBeVisible();
  expect(await storedSimulationWorkspace(page)).toEqual(offlineWorkspace);
  const backgroundPage = await context.newPage();
  await backgroundPage.goto("about:blank");
  await backgroundPage.bringToFront();
  await page.bringToFront();
  await backgroundPage.close();
  await expect(page.getByRole("heading", { name: "Day 3", exact: true })).toBeVisible();

  await page.evaluate(() => { document.documentElement.style.fontSize = "23.2px"; });
  const day3 = await resolveSimulatedDay(page, {
    expectEz: true,
    exerciseBranches: true,
    ezScreenshotPath: testInfo.outputPath("04-day3-exact-ez-bar.png"),
  });
  expect(day3.groupPositions).toEqual([
    "Group round 1 · member 1", "Group round 1 · member 2",
    "Group round 2 · member 1", "Group round 2 · member 2",
    "Group round 3 · member 1", "Group round 3 · member 2",
  ]);
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({
        tag: element.tagName,
        text: (element.innerText || "").trim().slice(0, 80),
        right: Math.round(element.getBoundingClientRect().right),
        left: Math.round(element.getBoundingClientRect().left),
      }))
      .filter((element) => element.right > width + 1 || element.left < -1)
      .slice(0, 10);
  });
  expect(overflow, `Large-text horizontal overflow: ${JSON.stringify(overflow)}`).toEqual([]);
  const banner = page.getByText("Simulation — not recorded", { exact: true });
  const bannerBox = await banner.boundingBox();
  expect(bannerBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("05-two-simulated-workouts-complete.png"), fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download labelled simulation JSON", exact: true }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toMatch(/^workout-simulation-sim_workspace_.*\.json$/);
  const artifactPath = await artifact.path();
  expect(artifactPath).not.toBeNull();
  const artifactBody = JSON.parse(await readFile(artifactPath!, "utf8")) as Record<string, unknown>;
  expect(artifactBody).toMatchObject({
    artifactKind: "workout_simulation",
    label: "SIMULATION — NOT A WORKOUT RECORD",
    schemaVersion: 1,
  });

  await page.getByRole("button", { name: "Exit or choose another simulation", exact: true }).click({ timeout: 10_000 });
  await page.getByRole("button", { name: "Resume simulation", exact: true }).click({ timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset this simulation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Simulation unavailable" })).toBeVisible();

  const afterDatabase = await mutationState(page);
  const afterStorage = await nonSimulationStorage(page);
  expect(afterDatabase).toEqual(beforeDatabase);
  expect(afterStorage).toEqual(beforeStorage);
  expect(mutationRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(badResponses).toEqual([]);

  await page.goto("/today");
  await expect(page.getByTestId("today-decision")).toContainText("Day 1");
  await expect(page.getByText(/needs attention/i)).toHaveCount(0);
  await page.goto("/program");
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByText(/Simulation — not recorded/)).toHaveCount(0);
  await page.goto("/coach");
  await expect(page.getByRole("heading", { name: "Review and decisions", exact: true })).toBeVisible();
  await expect(page.getByText(/Simulation — not recorded/)).toHaveCount(0);
  await page.goto("/export");
  await expect(page.getByRole("heading", { name: /Export/i })).toBeVisible();
  await expect(page.getByText(/workout simulation/i)).toHaveCount(0);
  await page.goto("/recovery");
  await expect(page.getByRole("heading", { name: /Recovery/i })).toBeVisible();
  await expect(page.getByText(/workout simulation/i)).toHaveCount(0);
  await page.goto("/archive");
  await expect(page.getByRole("heading", { name: /Archive/i })).toBeVisible();
  await expect(page.getByText(/workout simulation/i)).toHaveCount(0);

  const sourceWorkspace = JSON.parse(offlineWorkspace.value) as {
    source: { sourceDigest: string; program: { versionNo: number } };
  };
  const metadata = {
    runId: process.env.STAGE6_RUN_ID ?? "remediation-2026-07-22-stage6-r20",
    semanticOracleDigest: BA_ROUTINE_CHANGE_SEMANTIC_DIGEST,
    sourceDigest: sourceWorkspace.source.sourceDigest,
    sourceProgramVersion: sourceWorkspace.source.program.versionNo,
    canonicalBefore: beforeDatabase.digest,
    canonicalAfter: afterDatabase.digest,
    nonSimulationStorageBefore: digest(beforeStorage),
    nonSimulationStorageAfter: digest(afterStorage),
    viewport: page.viewportSize(),
    screen: await page.evaluate(() => ({ width: screen.width, height: screen.height })),
    appTextPercent: 145,
    timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    userAgent: await page.evaluate(() => navigator.userAgent),
    safeArea: "Playwright mobile emulation; physical safe area not claimed",
    fakeCoach: true,
    database: "fresh disposable PGlite via local-only bridge",
    expectedOfflineRequestFailures: expectedOfflineFailures.length,
    expectedNextNavigationCancellations: expectedNextNavigationCancellations.length,
  };
  await testInfo.attach("stage6-sanitized-metadata", {
    body: JSON.stringify(metadata, null, 2),
    contentType: "application/json",
  });
});
