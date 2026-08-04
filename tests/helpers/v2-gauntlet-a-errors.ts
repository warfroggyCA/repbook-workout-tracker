import { expect, type Page } from "@playwright/test";
import {
  isCorrelatedWebKitRscPrefetchCancellation,
  isExpectedWebKitRscLinkCancellation,
  observeNextRscPrefetches,
} from "./webkit-rsc-prefetch-errors";

const EXPECTED_APP_SHELL_PREFETCHES = new Set([
  "/today",
  "/coach",
  "/history",
  "/program",
  "/settings",
]);

export function observeGauntletPageErrors(
  page: Page,
  browserName: string,
  allowed: RegExp[] = [],
) {
  const errors: string[] = [];
  const nextRscPrefetches = observeNextRscPrefetches(page, browserName);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

  return {
    async expectNoUnexpected() {
      await nextRscPrefetches.settle();
      const rawErrors = errors.map((message) =>
        message.startsWith("page: ") ? message.slice("page: ".length) : message
      );
      const loadFailureCount = rawErrors.filter(
        (message) => message === "Load failed",
      ).length;
      const hasOnlyCorrelatedWebKitLoadFailures =
        browserName === "webkit" &&
        nextRscPrefetches.observedUrls.size > 0 &&
        loadFailureCount <= nextRscPrefetches.observedUrls.size;

      expect(
        errors.filter(
          (message) => {
            const rawMessage = message.startsWith("page: ")
              ? message.slice("page: ".length)
              : message;
            return (
              message !== "console: NEXT_REDIRECT" &&
              !(hasOnlyCorrelatedWebKitLoadFailures && rawMessage === "Load failed") &&
              !isExpectedWebKitRscLinkCancellation(
                rawMessage,
                browserName,
                EXPECTED_APP_SHELL_PREFETCHES,
              ) &&
              !isCorrelatedWebKitRscPrefetchCancellation(
                rawMessage,
                browserName,
                nextRscPrefetches.observedUrls,
              ) &&
              !allowed.some((pattern) => pattern.test(message))
            );
          },
        ),
      ).toEqual([]);
    },
  };
}
