import { expect, test } from "@playwright/test";
import { BA_WORKOUT_EMAIL, BA_WORKOUT_FIXTURE } from "../fixtures/ba-workout-contract";
import { writeBaCheckpointAudit } from "../helpers/ba-audit";
import { waitForHydratedServerAction } from "../helpers/react-readiness";

test("places one public-UI workout on its captured start-date identity", async ({ page }, testInfo) => {
  const expectedDate = process.env.BA_EXPECTED_LOCAL_DATE!;
  const expectedWeekday = process.env.BA_EXPECTED_WEEKDAY!;
  const expectedTimezone = process.env.BA_EXPECTED_TIMEZONE!;
  const expectedStartAt = process.env.BA_EXPECTED_START_AT!;
  const expectedFinishAt = process.env.BA_EXPECTED_FINISH_AT!;
  const expectedUtcOffsetMinutes = Number(process.env.BA_EXPECTED_UTC_OFFSET_MINUTES!);
  const expectedOrigin = process.env.BA_EXPECTED_ORIGIN!;
  const calendarCase = process.env.BA_EFFECTIVE_CALENDAR_CASE!;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const expectedRequestCancellations: string[] = [];
  const failedRequests: Array<{
    method: string;
    url: string;
    reason: string;
    status?: number;
  }> = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "unknown failure";
    const url = new URL(request.url());
    const exactRscCancellation =
      url.origin === expectedOrigin &&
      request.method() === "GET" &&
      !request.isNavigationRequest() &&
      url.searchParams.has("_rsc") &&
      request.headers().rsc === "1" &&
      reason === "net::ERR_ABORTED";
    const exactActionCancellation =
      url.origin === expectedOrigin &&
      request.method() === "POST" &&
      !request.isNavigationRequest() &&
      Boolean(request.headers()["next-action"]) &&
      reason === "net::ERR_ABORTED" &&
      (url.pathname === "/sign-in" ||
        url.pathname === "/today" ||
        /^\/session\/[0-9a-f-]{36}$/.test(url.pathname));
    if (exactRscCancellation || exactActionCancellation) {
      expectedRequestCancellations.push(
        `${request.method()} ${url.pathname}${url.search} — ${reason}`,
      );
      return;
    }
    failedRequests.push({ method: request.method(), url: request.url(), reason });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    failedRequests.push({
      method: response.request().method(),
      url: response.url(),
      reason: response.statusText() || "HTTP response error",
      status,
    });
  });

  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill(BA_WORKOUT_EMAIL);
  const login = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(login);
  await login.click();
  await expect(page).toHaveURL(/\/today$/);
  const observedTimezone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(observedTimezone).toBe(expectedTimezone);
  const temporalEvidence = await page.evaluate(
    ({ startAt, finishAt, timezone }) => {
      const localDate = (instant: string) => {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date(instant));
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
      };
      return {
        startAt,
        finishAt,
        startLocalDate: localDate(startAt),
        finishLocalDate: localDate(finishAt),
        startUtcOffsetMinutes: new Date(startAt).getTimezoneOffset(),
        finishUtcOffsetMinutes: new Date(finishAt).getTimezoneOffset(),
      };
    },
    { startAt: expectedStartAt, finishAt: expectedFinishAt, timezone: expectedTimezone },
  );
  expect(temporalEvidence.startLocalDate).toBe(expectedDate);
  expect(temporalEvidence.startUtcOffsetMinutes).toBe(expectedUtcOffsetMinutes);
  expect(temporalEvidence.finishUtcOffsetMinutes).toBe(expectedUtcOffsetMinutes);

  const start = page.getByRole("button", { name: "Train as planned", exact: true });
  await waitForHydratedServerAction(start);
  await start.click();
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: BA_WORKOUT_FIXTURE.program.days[0].name,
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("complementary", { name: "Workout status", exact: true })
    .getByRole("button", { name: "Finish", exact: true })
    .click();
  await page.getByRole("button", { name: /^(?:Finish early|Save workout)$/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+\?finished=1$/);
  await expect(page.getByText(new RegExp(`${expectedWeekday}, Jul ${Number(expectedDate.slice(-2))}`))).toBeVisible();

  await page.goto(`/history?range=all&calendarView=week&calendarDate=${expectedDate}`);
  const calendarRecord = page.getByRole("link", {
    name: new RegExp(`${BA_WORKOUT_FIXTURE.program.days[0].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  });
  await expect(calendarRecord).toBeVisible();
  await expect(calendarRecord).toHaveAttribute(
    "aria-label",
    new RegExp(`^${expectedWeekday === "Fri" ? "Friday" : "Saturday"}.*Open`),
  );
  const screenshot = testInfo.outputPath(`${calendarCase}-${expectedDate}-${expectedTimezone.replaceAll("/", "-")}.png`);
  await page.screenshot({
    path: screenshot,
    fullPage: true,
  });
  const observedCalendarLabel = await calendarRecord.getAttribute("aria-label");
  const expectedPlacement = calendarCase === "toronto-cross-midnight"
    ? `History keeps the workout on its captured start date ${expectedDate}, even though it finished after local midnight.`
    : `History places the workout on the captured start date ${expectedDate} for ${expectedTimezone}.`;
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await writeBaCheckpointAudit({
    evidenceRoot: testInfo.outputDir,
    attach: (name, options) => testInfo.attach(name, options),
    audit: {
      checkpointId: `QA-04-CALENDAR-${calendarCase.toUpperCase()}`,
      preconditions: "Fresh disposable BA workout database and guarded server start/finish instants.",
      action: `Start at ${expectedStartAt} and finish at ${expectedFinishAt} through the public UI with browser timezone ${observedTimezone}.`,
      expected: expectedPlacement,
      observed: `Browser timezone ${observedTimezone}; UTC offset ${temporalEvidence.startUtcOffsetMinutes} minutes at start and ${temporalEvidence.finishUtcOffsetMinutes} minutes at finish; start local date ${temporalEvidence.startLocalDate}; finish local date ${temporalEvidence.finishLocalDate}; calendar label ${observedCalendarLabel}; ${expectedRequestCancellations.length} exact Next redirect/RSC cancellations classified.`,
      status: "pass",
      severity: "none",
      url: page.url(),
      calibration: {
        viewport: { width: 440, height: 956 },
        screen: { width: 440, height: 956 },
        deviceScaleFactor: 2,
        mobile: true,
        touch: true,
        userAgent: await page.evaluate(() => navigator.userAgent),
        locale: await page.evaluate(() => navigator.language),
        timezone: observedTimezone,
      },
      consoleErrors,
      pageErrors,
      failedRequests,
      followUp: "Compare this classification with the user-reported one-day calendar placement.",
      artifacts: [{ label: "History calendar placement", kind: "screenshot", path: screenshot }],
    },
  });
});
