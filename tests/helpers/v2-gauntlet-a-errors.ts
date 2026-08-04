import { expect, type Page } from "@playwright/test";

export function observeGauntletPageErrors(
  page: Page,
  allowed: RegExp[] = [],
) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));

  return {
    expectNoUnexpected() {
      expect(
        errors.filter(
          (message) =>
            message !== "console: NEXT_REDIRECT" &&
            !allowed.some((pattern) => pattern.test(message)),
        ),
      ).toEqual([]);
    },
  };
}
