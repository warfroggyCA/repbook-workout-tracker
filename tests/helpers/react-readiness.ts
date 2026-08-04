import {
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

type NextDevelopmentRefreshControl = {
  freeze: () => void;
  resume: () => void;
};
const nextDevelopmentRefreshControls = new WeakMap<
  Page,
  NextDevelopmentRefreshControl
>();

export async function installNextDevelopmentRefreshControl(page: Page) {
  const existing = nextDevelopmentRefreshControls.get(page);
  if (existing) return existing;

  const state = { manuallyFrozen: false, navigationFrozen: false };
  let navigationResumeTimer: ReturnType<typeof setTimeout> | undefined;
  page.on("request", (request) => {
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    ) {
      state.navigationFrozen = true;
      if (navigationResumeTimer) clearTimeout(navigationResumeTimer);
    }
  });
  page.on("load", () => {
    navigationResumeTimer = setTimeout(() => {
      state.navigationFrozen = false;
    }, 250);
  });

  await page.routeWebSocket(/\/_next\/webpack-hmr(?:\?|$)/, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();

    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage((message) => {
      if (state.manuallyFrozen) return;
      if (state.navigationFrozen) {
        try {
          const payload = JSON.parse(message.toString()) as { type?: string };
          if (
            payload.type === "serverComponentChanges" ||
            payload.type === "addedPage" ||
            payload.type === "removedPage" ||
            payload.type === "reloadPage" ||
            payload.type === "middlewareChanges" ||
            payload.type === "clientChanges" ||
            payload.type === "serverOnlyChanges"
          ) {
            return;
          }
        } catch {
          // Non-JSON development protocol messages still need to reach Next.
        }
      }
      browserSocket.send(message);
    });
  });

  const control = {
    freeze: () => {
      state.manuallyFrozen = true;
    },
    resume: () => {
      state.manuallyFrozen = false;
    },
  };
  nextDevelopmentRefreshControls.set(page, control);
  return control;
}

export async function waitForHydratedReactHandler(locator: Locator) {
  await waitForHydratedReactEventHandler(locator, "onClick");
}

export async function waitForHydratedReactChangeHandler(locator: Locator) {
  await waitForHydratedReactEventHandler(locator, "onChange");
}

export async function openNativeDetails(details: Locator) {
  await expect(details).toHaveCount(1);
  await expect(details).toBeVisible();
  if ((await details.getAttribute("open")) !== null) return;

  const summary = details.locator(":scope > summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toBeVisible();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    try {
      await expect(details).toHaveAttribute("open", "", { timeout: 2_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function waitForHydratedReactEventHandler(
  locator: Locator,
  eventName: "onClick" | "onChange",
) {
  await expect
    .poll(
      async () => {
        if ((await locator.count()) !== 1) return false;
        return locator.evaluate((element, reactEventName) => {
          const propsKey = Object.getOwnPropertyNames(element).find((name) =>
            name.startsWith("__reactProps$")
          );
          if (!propsKey) return false;
          const props = (element as unknown as Record<string, unknown>)[
            propsKey
          ];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as Record<string, unknown>)[reactEventName] ===
              "function"
          );
        }, eventName);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

export async function waitForEquipmentSelectionsToSettle(page: Page) {
  await expect
    .poll(
      async () => {
        const regions = page.getByRole("region", {
          name: "Workout equipment setup",
        });
        if ((await regions.count()) === 0) return false;
        const texts = await regions.allTextContents();
        return texts.every(
          (value) =>
            value.includes("Using ") &&
            !/\b(?:Confirming|Pending|Updating)\b/.test(value),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem(
            "workout-tracker:equipment-selection-outbox:v1",
          );
          if (!raw) return 0;
          try {
            const parsed = JSON.parse(raw) as { entries?: unknown[] };
            return parsed.entries?.length ?? 0;
          } catch {
            return -1;
          }
        }),
      { timeout: 30_000 },
    )
    .toBe(0);
}

/**
 * Intentionally coupled to the pinned React 19.2.4 DOM internals: a server
 * action form is safe to submit only after React has hydrated its action prop.
 * A React upgrade should fail here clearly instead of racing Next's router.
 */
export async function waitForHydratedServerAction(button: Locator) {
  await expect
    .poll(
      async () => {
        if ((await button.count()) !== 1) return false;
        return button.evaluate((element) => {
          const form = element.closest("form");
          if (!form) return false;
          const propsKey = Object.getOwnPropertyNames(form).find((name) =>
            name.startsWith("__reactProps$")
          );
          if (!propsKey) return false;
          const props = (form as unknown as Record<string, unknown>)[propsKey];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as { action?: unknown }).action === "function"
          );
        });
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

export async function waitForHydratedFormSubmit(button: Locator) {
  await expect
    .poll(
      async () => {
        if ((await button.count()) !== 1) return false;
        return button.evaluate((element) => {
          const form = element.closest("form");
          if (!form) return false;
          const propsKey = Object.getOwnPropertyNames(form).find((name) =>
            name.startsWith("__reactProps$")
          );
          if (!propsKey) return false;
          const props = (form as unknown as Record<string, unknown>)[propsKey];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as { onSubmit?: unknown }).onSubmit === "function"
          );
        });
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}
