import type { Page, Request } from "@playwright/test";

const webKitAccessControlError =
  /^\/(127\.0\.0\.1:\d+)(\/[^ ]+\?[^ ]+) due to access control checks\.$/;
const rscToken = /^[A-Za-z0-9_-]+$/;
const historyRanges = new Set(["4w", "12w", "6m", "1y", "all"]);
const historyCalendarViews = new Set(["month", "week", "year"]);
const activityEditPath =
  /^\/activity\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/edit$/;
const webKitRscNavigationFallback =
  /^Failed to fetch RSC payload for (http:\/\/127\.0\.0\.1:\d+\/[^ ]*)\. Falling back to browser navigation\. TypeError: Load failed$/;

function isValidDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseWebKitRscCancellation(message: string) {
  const match = webKitAccessControlError.exec(message);
  if (!match) return null;

  const url = new URL(`http://${match[1]}${match[2]}`);
  const tokens = url.searchParams.getAll("_rsc");
  if (tokens.length !== 1 || !rscToken.test(tokens[0])) return null;
  return url;
}

function hasOnlyValidHistoryContext(url: URL) {
  const allowed = new Set(["_rsc", "range", "calendarView", "calendarDate"]);
  for (const key of url.searchParams.keys()) {
    if (
      !allowed.has(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      return false;
    }
  }

  const range = url.searchParams.get("range");
  if (range !== null && !historyRanges.has(range)) return false;

  const calendarView = url.searchParams.get("calendarView");
  if (
    calendarView !== null &&
    !historyCalendarViews.has(calendarView)
  ) {
    return false;
  }

  const calendarDate = url.searchParams.get("calendarDate");
  if (calendarDate !== null && !isValidDateKey(calendarDate)) {
    return false;
  }

  return true;
}

export async function isNextRscPrefetch(request: Request) {
  const headers = await request.allHeaders();
  // Next marks non-document App Router prefetches with all three properties.
  // Recording their exact URL lets the tests distinguish WebKit's cancelled
  // prefetch message from application, document, and security failures.
  return (
    request.method() === "GET" &&
    request.resourceType() === "fetch" &&
    !request.isNavigationRequest() &&
    headers.rsc === "1" &&
    (headers["next-router-prefetch"] === "1" ||
      headers["next-router-prefetch"] === "2")
  );
}

export async function isSuccessfulNextRscPrefetch(request: Request) {
  if (!(await isNextRscPrefetch(request))) return false;
  const response = await request.response();
  return response?.ok() === true;
}

export function observeNextRscPrefetches(
  page: Page,
  browserName: string,
) {
  const observedUrls = new Set<string>();
  const pendingObservations = new Set<Promise<void>>();

  if (browserName === "webkit") {
    page.on("request", (request) => {
      const observation = isNextRscPrefetch(request)
        .then((isPrefetch) => {
          if (isPrefetch) observedUrls.add(request.url());
        })
        .catch(() => undefined);
      pendingObservations.add(observation);
      void observation.finally(() => pendingObservations.delete(observation));
    });
  }

  return {
    observedUrls,
    async settle() {
      await Promise.all([...pendingObservations]);
    },
  };
}

export function isCorrelatedWebKitRscPrefetchCancellation(
  message: string,
  browserName: string,
  observedUrls: ReadonlySet<string>,
) {
  if (browserName !== "webkit") return false;

  const url = parseWebKitRscCancellation(message);
  return url !== null && observedUrls.has(url.href);
}

export function isExpectedWebKitRscLinkCancellation(
  message: string,
  browserName: string,
  expectedPaths: ReadonlySet<string>,
) {
  if (browserName !== "webkit") return false;

  const url = parseWebKitRscCancellation(message);
  if (!url) return false;

  return (
    expectedPaths.has(url.pathname) &&
    [...url.searchParams.keys()].every((key) => key === "_rsc")
  );
}

export function isExpectedWebKitRscHistoryLinkCancellation(
  message: string,
  browserName: string,
) {
  if (browserName !== "webkit") return false;

  const url = parseWebKitRscCancellation(message);
  if (!url || !hasOnlyValidHistoryContext(url)) return false;

  return url.pathname === "/history" || activityEditPath.test(url.pathname);
}

export function isExpectedWebKitRscNavigationFallback(
  message: string,
  browserName: string,
  expectedPath: string,
) {
  if (browserName !== "webkit") return false;

  const match = webKitRscNavigationFallback.exec(message);
  if (!match) return false;

  const url = new URL(match[1]);
  return url.pathname === expectedPath && url.search === "" && url.hash === "";
}
