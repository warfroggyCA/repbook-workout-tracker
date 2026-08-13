import type { Page, Request } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscHistoryLinkCancellation,
  isExpectedWebKitRscLinkCancellation,
  isExpectedWebKitRscNavigationFallback,
  isNextRscPrefetch,
  isSuccessfulNextRscPrefetch,
  observeNextRscPrefetches,
} from "../helpers/webkit-rsc-prefetch-errors";

const prefetchUrl =
  "http://127.0.0.1:3126/settings?_rsc=ezb0gZxFIgnpyneu";
const webKitCancellation =
  "/127.0.0.1:3126/settings?_rsc=ezb0gZxFIgnpyneu due to access control checks.";

describe("WebKit RSC prefetch cancellation classification", () => {
  it.each([
    ["an ordinary fetch", "GET", "fetch", false, { rsc: "1" }],
    [
      "a navigation request",
      "GET",
      "document",
      true,
      { rsc: "1", "next-router-prefetch": "1" },
    ],
    [
      "an unmarked RSC fetch",
      "GET",
      "fetch",
      false,
      { rsc: "1", "next-router-prefetch": "0" },
    ],
    [
      "a non-GET request",
      "POST",
      "fetch",
      false,
      { rsc: "1", "next-router-prefetch": "1" },
    ],
  ])(
    "does not classify %s as a Next prefetch",
    async (_label, method, resourceType, isNavigation, headers) => {
      const request = {
        allHeaders: async () => headers,
        isNavigationRequest: () => isNavigation,
        method: () => method,
        resourceType: () => resourceType,
      } as unknown as Request;

      await expect(isNextRscPrefetch(request)).resolves.toBe(false);
    },
  );

  it("waits for complete asynchronous request headers", async () => {
    let onRequest: ((request: Request) => void) | undefined;
    const page = {
      on(event: string, listener: (request: Request) => void) {
        if (event === "request") onRequest = listener;
      },
    } as unknown as Page;
    let resolveHeaders:
      | ((headers: Record<string, string>) => void)
      | undefined;
    const headers = new Promise<Record<string, string>>((resolve) => {
      resolveHeaders = resolve;
    });
    const request = {
      allHeaders: () => headers,
      isNavigationRequest: () => false,
      method: () => "GET",
      resourceType: () => "fetch",
      url: () => prefetchUrl,
    } as unknown as Request;

    const observation = observeNextRscPrefetches(page, "webkit");
    onRequest?.(request);
    expect(observation.observedUrls).toEqual(new Set());

    resolveHeaders?.({
      rsc: "1",
      "next-router-prefetch": "1",
    });
    await observation.settle();

    expect(observation.observedUrls).toEqual(new Set([prefetchUrl]));
  });

  it.each([
    ["a failed request", null],
    ["an unauthorized response", { ok: () => false }],
  ])("does not exempt %s", async (_label, response) => {
    const request = {
      allHeaders: async () => ({
        rsc: "1",
        "next-router-prefetch": "1",
      }),
      isNavigationRequest: () => false,
      method: () => "GET",
      resourceType: () => "fetch",
      response: async () => response,
    } as unknown as Request;

    await expect(isSuccessfulNextRscPrefetch(request)).resolves.toBe(false);
  });

  it("exempts a successful marked GET prefetch", async () => {
    const request = {
      allHeaders: async () => ({
        rsc: "1",
        "next-router-prefetch": "1",
      }),
      isNavigationRequest: () => false,
      method: () => "GET",
      resourceType: () => "fetch",
      response: async () => ({ ok: () => true }),
    } as unknown as Request;

    await expect(isSuccessfulNextRscPrefetch(request)).resolves.toBe(true);
  });

  it("accepts only an exact WebKit message correlated to an observed prefetch", () => {
    expect(
      isCorrelatedWebKitRscPrefetchCancellation(
        webKitCancellation,
        "webkit",
        new Set([prefetchUrl]),
      ),
    ).toBe(true);
  });

  it.each([
    ["another browser", "chromium", webKitCancellation, [prefetchUrl]],
    ["an unobserved request", "webkit", webKitCancellation, []],
    [
      "an application error",
      "webkit",
      "TypeError: Cannot read properties of undefined",
      [prefetchUrl],
    ],
    [
      "a document error",
      "webkit",
      "/127.0.0.1:3126/settings due to access control checks.",
      [prefetchUrl],
    ],
    [
      "a different RSC request",
      "webkit",
      "/127.0.0.1:3126/session/example?_rsc=other due to access control checks.",
      [prefetchUrl],
    ],
    [
      "a security error",
      "webkit",
      "Refused to execute a script because its hash was not allowed by Content Security Policy.",
      [prefetchUrl],
    ],
  ])("rejects %s", (_label, browserName, message, observedUrls) => {
    expect(
      isCorrelatedWebKitRscPrefetchCancellation(
        message,
        browserName,
        new Set(observedUrls),
      ),
    ).toBe(false);
  });

  it("accepts an unobservable WebKit cancellation only for a reviewed app-shell link", () => {
    expect(
      isExpectedWebKitRscLinkCancellation(
        webKitCancellation,
        "webkit",
        new Set(["/settings", "/today"]),
      ),
    ).toBe(true);
  });

  it("accepts the exact recovered WebKit RSC navigation fallback for a reviewed route", () => {
    expect(
      isExpectedWebKitRscNavigationFallback(
        "Failed to fetch RSC payload for http://127.0.0.1:3136/today. Falling back to browser navigation. TypeError: Load failed",
        "webkit",
        "/today",
      ),
    ).toBe(true);
  });

  it.each([
    ["another browser", "chromium", "/today", ""],
    ["another route", "webkit", "/history", ""],
    ["a query-bearing route", "webkit", "/today", "?preview=example"],
    ["another error", "webkit", "/today", " caused by application failure"],
  ])(
    "does not accept %s as a recovered WebKit RSC navigation fallback",
    (_label, browserName, expectedPath, suffix) => {
      const message = suffix.startsWith("?")
        ? `Failed to fetch RSC payload for http://127.0.0.1:3136/today${suffix}. Falling back to browser navigation. TypeError: Load failed`
        : `Failed to fetch RSC payload for http://127.0.0.1:3136/today. Falling back to browser navigation. TypeError: Load failed${suffix}`;
      expect(
        isExpectedWebKitRscNavigationFallback(
          message,
          browserName,
          expectedPath,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["another browser", "chromium", webKitCancellation, ["/settings"]],
    ["an unlisted route", "webkit", webKitCancellation, ["/history"]],
    [
      "a document error",
      "webkit",
      "/127.0.0.1:3126/settings due to access control checks.",
      ["/settings"],
    ],
    [
      "an application error",
      "webkit",
      "TypeError: Cannot read properties of undefined",
      ["/settings"],
    ],
    [
      "a query-bearing route",
      "webkit",
      "/127.0.0.1:3126/history?range=12w&_rsc=token due to access control checks.",
      ["/history"],
    ],
  ])(
    "does not accept %s as a reviewed app-shell cancellation",
    (_label, browserName, message, expectedPaths) => {
      expect(
        isExpectedWebKitRscLinkCancellation(
          message,
          browserName,
          new Set(expectedPaths),
        ),
      ).toBe(false);
    },
  );

  it.each([
    [
      "History context",
      "/127.0.0.1:3100/history?range=12w&calendarView=month&_rsc=token due to access control checks.",
    ],
    [
      "an activity edit with History context",
      "/127.0.0.1:3100/activity/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9/edit?range=all&calendarView=year&calendarDate=2020-01-03&_rsc=token due to access control checks.",
    ],
    [
      "an activity edit without History context",
      "/127.0.0.1:3100/activity/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9/edit?_rsc=token due to access control checks.",
    ],
    [
      "a completed workout detail",
      "/127.0.0.1:3100/history/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9?finished=1&_rsc=token due to access control checks.",
    ],
    [
      "a workout detail without completion context",
      "/127.0.0.1:3100/history/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9?_rsc=token due to access control checks.",
    ],
  ])("accepts an exact WebKit cancellation for %s", (_label, message) => {
    expect(
      isExpectedWebKitRscHistoryLinkCancellation(message, "webkit"),
    ).toBe(true);
  });

  it.each([
    [
      "another browser",
      "chromium",
      "/127.0.0.1:3100/history?range=12w&_rsc=token due to access control checks.",
    ],
    [
      "an activity detail route",
      "webkit",
      "/127.0.0.1:3100/activity/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9?_rsc=token due to access control checks.",
    ],
    [
      "a malformed activity identity",
      "webkit",
      "/127.0.0.1:3100/activity/not-a-uuid/edit?_rsc=token due to access control checks.",
    ],
    [
      "an unsupported range",
      "webkit",
      "/127.0.0.1:3100/history?range=forever&_rsc=token due to access control checks.",
    ],
    [
      "an unrelated query parameter",
      "webkit",
      "/127.0.0.1:3100/history?range=12w&danger=true&_rsc=token due to access control checks.",
    ],
    [
      "an unsupported workout-detail completion value",
      "webkit",
      "/127.0.0.1:3100/history/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9?finished=0&_rsc=token due to access control checks.",
    ],
    [
      "an unrelated workout-detail query parameter",
      "webkit",
      "/127.0.0.1:3100/history/4eb1ab8d-6551-4eb1-84e7-3810abcb1ec9?danger=true&_rsc=token due to access control checks.",
    ],
    [
      "an invalid calendar date",
      "webkit",
      "/127.0.0.1:3100/history?calendarDate=2026-02-31&_rsc=token due to access control checks.",
    ],
    [
      "a duplicate RSC token",
      "webkit",
      "/127.0.0.1:3100/history?_rsc=first&_rsc=second due to access control checks.",
    ],
    [
      "a document error",
      "webkit",
      "/127.0.0.1:3100/history due to access control checks.",
    ],
    [
      "an application error",
      "webkit",
      "TypeError: Cannot read properties of undefined",
    ],
  ])(
    "rejects %s as a reviewed History-link cancellation",
    (_label, browserName, message) => {
      expect(
        isExpectedWebKitRscHistoryLinkCancellation(message, browserName),
      ).toBe(false);
    },
  );
});
