import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  installNextDevelopmentRefreshControl,
  waitForHydratedServerAction,
} from "../helpers/react-readiness";

const isCI = Boolean(process.env.CI);

/**
 * Returning-user equipment management and setup review journeys. This suite
 * (UI-002, UI-005–UI-007). These tests share the suite's one fresh disposable
 * database and restore the seeded inventory display state they change, so the
 * later smoke flows keep their exact expectations.
 */

async function waitForReactHandler(locator: Locator) {
  await expect
    .poll(
      async () => {
        if ((await locator.count()) !== 1) return false;
        return locator.evaluate((element) => {
          const propsKey = Object.getOwnPropertyNames(element).find((name) =>
            name.startsWith("__reactProps$")
          );
          if (!propsKey) return false;
          const props = (element as unknown as Record<string, unknown>)[propsKey];
          return (
            typeof props === "object" &&
            props !== null &&
            typeof (props as { onClick?: unknown }).onClick === "function"
          );
        });
      },
      { timeout: isCI ? 30_000 : 10_000 }
    )
    .toBe(true);
}

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("allowlisted email").fill("owner@example.com");
  const devLogin = page.getByRole("button", { name: "Dev login", exact: true });
  await waitForHydratedServerAction(devLogin);
  await devLogin.click();
  await expect(page).toHaveURL(/\/today$/);
}

async function openManager(page: Page) {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const manage = page.getByRole("button", { name: "Manage equipment" });
  await expect(manage).toBeVisible();
  await waitForReactHandler(manage);
  await manage.click();
  await expect(page).toHaveURL(/\/settings\/equipment$/);
  await expect(
    page.getByRole("heading", { name: "Manage equipment", exact: true })
  ).toBeVisible();
}

async function openItemDrawer(page: Page, label: string) {
  const card = page.getByRole("button", {
    name: `Edit ${label}`,
    exact: true,
  });
  await waitForReactHandler(card);
  await card.click();
  const drawer = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: label, exact: true }),
  });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function openPlateDrawer(page: Page) {
  const card = page.getByRole("button", {
    name: "Edit weight plates",
    exact: true,
  });
  await waitForReactHandler(card);
  await card.click();
  const drawer = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Weight plates", exact: true }),
  });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function saveDrawer(drawer: Locator) {
  const save = drawer.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await waitForReactHandler(save);
  await save.click();
  await expect(drawer).toHaveCount(0);
}

async function reviewChanges(page: Page) {
  const review = page.getByRole("button", { name: "Review changes", exact: true });
  await expect(review).toBeEnabled();
  await waitForReactHandler(review);
  await review.click();
}

async function saveFromReview(page: Page, confirmReduction = false) {
  await expect(
    page.getByRole("heading", { name: "Review inventory changes" })
  ).toBeVisible();
  if (confirmReduction) {
    await page
      .getByRole("checkbox", { name: /I understand this save removes equipment/ })
      .click();
  }
  const save = page.getByRole("button", {
    name: "Save inventory",
    exact: true,
  });
  await waitForReactHandler(save);
  await save.click();
  await expect(page).toHaveURL(/\/settings\?equipment-saved=updated$/);
  await expect(
    page.getByText("Your equipment inventory was saved", { exact: false })
  ).toBeVisible();
}

async function expandSettingsFamily(page: Page, family: RegExp, region: string) {
  const button = page.getByRole("button", { name: family });
  await waitForReactHandler(button);
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
  return page.getByRole("region", { name: region });
}

test("completed accounts are redirected away from first-time setup", async ({
  page,
  baseURL,
}) => {
  await signIn(page);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/settings\/setup$/);
  const stepResponse = await page.request.get("/setup/equipment", {
    maxRedirects: 0,
  });
  expect([303, 307]).toContain(stepResponse.status());
  expect(new URL(stepResponse.headers().location!, baseURL).pathname).toBe(
    "/settings/setup"
  );
});

test("fixed dumbbells use exact owned weights and explain multi-pair quantity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await signIn(page);
  await openManager(page);
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await page.getByRole("button", { name: "Dumbbell", exact: true }).click();

  const drawer = page.getByRole("dialog");
  const saveChanges = drawer.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await expect(saveChanges).toBeEnabled();
  await expect(
    drawer.getByText("Choose Pair or Single first", { exact: true })
  ).toBeVisible();
  await drawer
    .getByRole("group", { name: "Adjustable or fixed for Dumbbell" })
    .getByRole("button", { name: "Fixed weights", exact: true })
    .click();
  await expect(saveChanges).toBeDisabled();
  await expect(
    drawer.getByText(
      "Choose Adjustable or Fixed weights and Pair or Single before saving.",
      { exact: true }
    )
  ).toBeVisible();
  await drawer
    .getByRole("group", { name: "Pair or single for Dumbbell" })
    .getByRole("button", { name: "Pair", exact: true })
    .click();

  await expect(saveChanges).toBeDisabled();
  await expect(
    drawer.getByText(
      "Select at least one owned weight before saving fixed equipment.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    drawer.getByText("How many pairs at each weight", { exact: true })
  ).toBeVisible();
  await expect(
    drawer.getByText(
      "Quantity 1 means one matched pair at every selected weight. Add another entry if a weight has a different quantity or configuration.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(drawer.getByLabel("Minimum")).toHaveCount(0);
  await expect(drawer.getByLabel("Maximum")).toHaveCount(0);
  const owned = drawer.getByRole("group", {
    name: "Owned dumbbell weights for Dumbbell",
  });
  await owned.getByRole("button", { name: "5", exact: true }).click();
  await expect(saveChanges).toBeEnabled();
  await owned.getByRole("button", { name: "10", exact: true }).click();
  await expect(owned.getByRole("button", { name: "5", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await drawer
    .getByRole("button", { name: "Increase quantity for Dumbbell" })
    .click();
  await expect(
    drawer.getByText("How many pairs at each weight", { exact: true })
  ).toBeVisible();

  await drawer
    .getByRole("group", { name: "Adjustable or fixed for Dumbbell" })
    .getByRole("button", { name: "Adjustable", exact: true })
    .click();
  await expect(
    drawer.getByText("How many adjustable pairs", { exact: true })
  ).toBeVisible();
  await expect(drawer.getByLabel("Minimum")).toHaveValue("5");
  await expect(drawer.getByLabel("Maximum")).toHaveValue("10");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserErrors).toEqual([]);
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("adds equipment, repeated types, and selection-driven plates, then reloads them exactly", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await signIn(page);
  await openManager(page);

  // The card grid shows saved physical equipment directly. Compatibility
  // plate/bodyweight rows stay hidden, with one shared plate card and one
  // explanation of implicit bodyweight capability.
  await expect(page.getByText("Olympic plates", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bodyweight", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Bodyweight training is always available/)).toHaveCount(1);
  await expect(page.getByText("Adjustable dumbbells (5–35 lb pair)")).toBeVisible();
  await expect(page.locator("#weight-plates-card")).toContainText("12 plates across 5 sizes");
  await expect(
    page.getByRole("button", { name: "No changes to save", exact: true })
  ).toBeDisabled();

  // Add a specialty type through the complete picker.
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Weight plates", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bodyweight", exact: true })).toHaveCount(0);
  await page.getByLabel("Search equipment types").fill("trap");
  await page.getByRole("button", { name: "Trap / hex bar", exact: true }).click();
  const trapDrawer = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Trap / hex bar", exact: true }),
  });
  await saveDrawer(trapDrawer);
  await expect(page.getByRole("button", { name: "Edit Trap / hex bar" })).toContainText("New");

  // Add a second item of an existing type with its own label.
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await page.getByRole("button", { name: "Bench", exact: true }).click();
  // Use the sole open dialog here because its accessible name updates live
  // when the item name changes.
  const benchDrawer = page.getByRole("dialog");
  await benchDrawer.getByLabel("Name").fill("Flat utility bench");
  await benchDrawer.getByRole("group", { name: "Bench type for Flat utility bench" })
    .getByRole("button", { name: "Flat", exact: true })
    .click();
  await saveDrawer(benchDrawer);

  // The plate drawer stages individual quantities locally, including odd
  // quantities and custom sizes, until its Save changes button is used.
  const plateDrawer = await openPlateDrawer(page);
  const increase45 = plateDrawer.getByRole("button", {
    name: "Increase quantity of 45 lb plates",
  });
  await waitForReactHandler(increase45);
  await increase45.click();
  await expect(
    plateDrawer.getByRole("spinbutton", { name: "Quantity of 45 lb plates", exact: true })
  ).toHaveValue("3");
  await expect(plateDrawer.getByText("1 spare", { exact: true }).first()).toBeVisible();
  await plateDrawer.locator("#add-plate-weight").click();
  await page.getByRole("option", { name: "Custom…", exact: true }).click();
  await plateDrawer.locator("#add-plate-custom").fill("1.25");
  await plateDrawer.locator("#add-plate-quantity").fill("1");
  await plateDrawer.getByRole("button", { name: "Add to inventory", exact: true }).click();
  await expect(plateDrawer.getByText("1.25 lb", { exact: true })).toBeVisible();

  // Duplicate custom sizes are rejected inline with a named message.
  await plateDrawer.locator("#add-plate-weight").click();
  await page.getByRole("option", { name: "Custom…", exact: true }).click();
  await plateDrawer.locator("#add-plate-custom").fill("45");
  await plateDrawer.getByRole("button", { name: "Add to inventory", exact: true }).click();
  await expect(
    plateDrawer.getByText("45 lb is already in your inventory — raise its quantity instead.")
  ).toBeVisible();
  await saveDrawer(plateDrawer);

  await reviewChanges(page);
  await expect(page.getByText("Trap / hex bar", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Flat utility bench", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/45 lb: 2 plates → 3 plates/)).toBeVisible();
  await expect(page.getByText(/1\.25 lb: added at 1 plate/)).toBeVisible();
  await saveFromReview(page);

  // Settings renders the fresh inventory immediately.
  const barsRegion = await expandSettingsFamily(
    page,
    /Bars & weight plates/,
    "Bars & weight plates items"
  );
  await expect(barsRegion.getByText("45 lb × 3 (1 spare)", { exact: true })).toBeVisible();
  await expect(barsRegion.getByText("1.25 lb × 1 (1 spare)", { exact: true })).toBeVisible();
  await expect(
    barsRegion.getByText("Trap / hex bar", { exact: true }).first()
  ).toBeVisible();

  // Reload the manager: both same-type items and the custom size come back
  // exactly, and an unchanged draft cannot be saved.
  await openManager(page);
  await expect(page.getByText("Adjustable bench", { exact: true })).toBeVisible();
  await expect(page.getByText("Flat utility bench", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Trap / hex bar", { exact: true }).first()
  ).toBeVisible();
  const reloadedPlateDrawer = await openPlateDrawer(page);
  await expect(
    reloadedPlateDrawer.getByRole("spinbutton", {
      name: "Quantity of 45 lb plates",
      exact: true,
    })
  ).toHaveValue("3");
  await reloadedPlateDrawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "No changes to save", exact: true })
  ).toBeDisabled();
  expect(browserErrors).toEqual([]);
});

test("edits Olympic and EZ empty weights beside their items and reviews exact totals", async ({ page }) => {
  await signIn(page);
  await openManager(page);

  await expect(page.getByText("Empty bar 45 lb · collars 0 lb total", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty bar 18 lb · collars 0 lb total", { exact: true })).toBeVisible();

  // Drawer Cancel discards its local staging without dirtying the page draft.
  const cancelledDrawer = await openItemDrawer(page, "Olympic barbell (45 lb)");
  await cancelledDrawer.getByLabel("Empty bar weight").fill("46");
  await cancelledDrawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "No changes to save" })).toBeDisabled();

  const olympicDrawer = await openItemDrawer(page, "Olympic barbell (45 lb)");
  await expect(olympicDrawer.getByLabel("Empty bar weight")).toHaveValue("45");
  await olympicDrawer.getByLabel("Empty bar weight").fill("44");
  await olympicDrawer.getByLabel("Both collars, total").fill("1");
  await expect(olympicDrawer.getByText(/Enter the bar by itself, before plates/)).toBeVisible();
  await saveDrawer(olympicDrawer);

  const ezDrawer = await openItemDrawer(page, "EZ curl bar (18 lb)");
  await ezDrawer.getByLabel("Empty bar weight").fill("25");
  await ezDrawer.getByLabel("Both collars, total").fill("1");
  await saveDrawer(ezDrawer);

  await reviewChanges(page);
  await expect(page.getByText("Empty bar weight: 45 lb → 44 lb", { exact: true })).toBeVisible();
  await expect(page.getByText("Both collars, total: 0 lb → 1 lb", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Empty assembled load: 45 lb → 45 lb", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty bar weight: 18 lb → 25 lb", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty assembled load: 18 lb → 26 lb", { exact: true })).toBeVisible();
  await expect(page.getByText(/Future plate guidance and progression steps will use/)).toBeVisible();
  await saveFromReview(page);

  await openManager(page);
  await expect(page.getByText("Empty bar 44 lb · collars 1 lb total", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty bar 25 lb · collars 1 lb total", { exact: true })).toBeVisible();

  // Restore the shared fixture for later stateful journeys.
  const restoredOlympic = await openItemDrawer(page, "Olympic barbell (45 lb)");
  await restoredOlympic.getByLabel("Empty bar weight").fill("45");
  await restoredOlympic.getByLabel("Both collars, total").fill("0");
  await saveDrawer(restoredOlympic);
  const restoredEz = await openItemDrawer(page, "EZ curl bar (18 lb)");
  await restoredEz.getByLabel("Empty bar weight").fill("18");
  await restoredEz.getByLabel("Both collars, total").fill("0");
  await saveDrawer(restoredEz);
  await reviewChanges(page);
  await saveFromReview(page);
});

test("cancel confirms before discarding a dirty draft and leaves the inventory unchanged", async ({
  page,
}) => {
  await signIn(page);
  await openManager(page);
  const ropeDrawer = await openItemDrawer(page, "Skipping rope");
  await ropeDrawer.getByRole("button", {
    name: "Remove Skipping rope",
    exact: true,
  }).click();
  await expect(page.getByText("Will be removed on save")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByText("Discard unsaved equipment changes?")
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByText("Will be removed on save")).toBeVisible();

  // In-app navigation is guarded too; the bottom navigation cannot silently
  // discard a dirty inventory draft.
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.getByText("Discard unsaved equipment changes?")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/equipment$/);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const toolsRegion = await expandSettingsFamily(
    page,
    /Conditioning tools/,
    "Conditioning tools items"
  );
  await expect(toolsRegion.getByText("Skipping rope", { exact: true })).toBeVisible();
});

test("validation summary links to and focuses the first invalid equipment field", async ({
  page,
}) => {
  await signIn(page);
  await openManager(page);
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await page.getByRole("button", { name: "Bench", exact: true }).click();
  const drawer = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Bench", exact: true }),
  });
  const name = drawer.getByLabel("Name");
  await name.fill("");
  await saveDrawer(drawer);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  // Review opens the owning drawer and focuses the first invalid field. Close
  // it once to expose the persistent summary link, then prove the link repeats
  // that same drawer-and-focus behavior.
  await expect(page.getByLabel("Name")).toBeFocused();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const issue = page.getByRole("link", { name: "Every item needs a name." });
  await expect(issue).toBeVisible();
  await issue.click();
  const focusedName = page.getByLabel("Name");
  await expect(focusedName).toBeFocused();
  await focusedName.fill("Temporary validation bench");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
});

test("keeps the edited draft after a network failure and allows recovery", async ({
  page,
}) => {
  await signIn(page);
  await openManager(page);
  const ellipticalDrawer = await openItemDrawer(page, "Elliptical");
  await ellipticalDrawer
    .getByRole("button", { name: "Increase quantity for Elliptical" })
    .click();
  await saveDrawer(ellipticalDrawer);

  await page.route("**/settings/equipment", async (route) => {
    if (route.request().method() === "POST") {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await reviewChanges(page);
  await expect(
    page.getByRole("alert").filter({
      hasText: "The inventory review could not be reached",
    })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Elliptical" })).toContainText("Qty 2");

  await page.unroute("**/settings/equipment");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("a stale tab cannot save over newer inventory and offers explicit recovery", async ({
  page,
  context,
}) => {
  await installNextDevelopmentRefreshControl(page);
  await signIn(page);
  await openManager(page);
  await page.waitForLoadState("networkidle");
  const ellipticalDrawer = await openItemDrawer(page, "Elliptical");
  await ellipticalDrawer.getByRole("button", { name: "Increase quantity for Elliptical" }).click();
  await saveDrawer(ellipticalDrawer);
  await reviewChanges(page);
  await expect(
    page.getByRole("heading", { name: "Review inventory changes" })
  ).toBeVisible();
  const keepEditingBeforeConflict = page.getByRole("button", {
    name: "Keep editing",
    exact: true,
  });
  await waitForReactHandler(keepEditingBeforeConflict);
  await keepEditingBeforeConflict.click();
  await expect(page.getByRole("button", { name: "Edit Elliptical" })).toContainText(
    "Qty 2"
  );
  await page.waitForLoadState("networkidle");
  const staleRefreshControl =
    await installNextDevelopmentRefreshControl(page);
  staleRefreshControl.freeze();

  // A second tab changes and saves the inventory first.
  const other = await context.newPage();
  await openManager(other);
  const otherRopeDrawer = await openItemDrawer(other, "Skipping rope");
  await otherRopeDrawer
    .getByRole("button", { name: "Increase quantity for Skipping rope" })
    .click();
  await saveDrawer(otherRopeDrawer);
  await reviewChanges(other);
  await saveFromReview(other);
  await other.close();
  staleRefreshControl.resume();

  // The first tab is now stale: the save is refused, the draft is retained.
  await reviewChanges(page);
  await expect(
    page.getByText("Your inventory changed somewhere else after this page loaded.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep reviewing", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Bench type for Flat utility bench" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit Elliptical" })).toContainText("Qty 2");

  await reviewChanges(page);
  await page.getByRole("button", { name: "Reload current inventory", exact: true }).click();
  await expect(page.getByText("Skipping rope", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "No changes to save", exact: true })
  ).toBeDisabled();

  // Restore the seeded quantity for the later flows.
  const restoredRopeDrawer = await openItemDrawer(page, "Skipping rope");
  await restoredRopeDrawer
    .getByRole("button", { name: "Decrease quantity for Skipping rope" })
    .click();
  await saveDrawer(restoredRopeDrawer);
  await reviewChanges(page);
  await saveFromReview(page);
});

test("removing Program-relevant equipment warns truthfully, requires confirmation, and never rewrites the Program", async ({
  page,
}) => {
  await signIn(page);
  await openManager(page);
  const dumbbellDrawer = await openItemDrawer(page, "Adjustable dumbbells (5–35 lb pair)");
  await dumbbellDrawer
    .getByRole("button", {
      name: "Remove Adjustable dumbbells (5–35 lb pair)",
      exact: true,
    })
    .click();
  await reviewChanges(page);
  await expect(page.getByText("No longer available")).toBeVisible();
  await expect(
    page.getByText(/exercises? will no longer be available/)
  ).toBeVisible();
  await expect(page.getByText(/Your current Program uses/)).toBeVisible();
  await expect(page.getByText(/The Program itself is not rewritten/)).toBeVisible();
  const save = page.getByRole("button", { name: "Save inventory", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();

  // Cancel the whole draft: nothing changed.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const handheldRegion = await expandSettingsFamily(
    page,
    /Dumbbells & handheld weights/,
    "Dumbbells & handheld weights items"
  );
  await expect(
    handheldRegion.getByText("Adjustable dumbbells (5–35 lb pair)")
  ).toBeVisible();

  // Repeat and confirm: availability changes, the Program does not.
  await openManager(page);
  const secondDumbbellDrawer = await openItemDrawer(page, "Adjustable dumbbells (5–35 lb pair)");
  await secondDumbbellDrawer
    .getByRole("button", {
      name: "Remove Adjustable dumbbells (5–35 lb pair)",
      exact: true,
    })
    .click();
  await reviewChanges(page);
  await saveFromReview(page, true);
  const handheldAfter = await expandSettingsFamily(
    page,
    /Dumbbells & handheld weights/,
    "Dumbbells & handheld weights items"
  );
  await expect(
    handheldAfter.getByText("Adjustable dumbbells (5–35 lb pair)")
  ).toHaveCount(0);
  await page.goto("/program");
  await expect(page.getByText("Dumbbell Bench Press").first()).toBeVisible();

  // Intentionally re-adding the same item reactivates the same record with
  // its preserved details rather than creating a blank duplicate.
  await openManager(page);
  const addEquipment = page.getByRole("button", {
    name: "Add equipment",
    exact: true,
  });
  await waitForReactHandler(addEquipment);
  await addEquipment.click();
  const dumbbellType = page.getByRole("button", {
    name: "Dumbbell",
    exact: true,
  });
  await waitForReactHandler(dumbbellType);
  await dumbbellType.click();
  const addedDumbbellDrawer = page.getByRole("dialog");
  await addedDumbbellDrawer.getByLabel("Name").fill("Adjustable dumbbells (5–35 lb pair)");
  await saveDrawer(addedDumbbellDrawer);
  await reviewChanges(page);
  await saveFromReview(page);
  const handheldRestored = await expandSettingsFamily(
    page,
    /Dumbbells & handheld weights/,
    "Dumbbells & handheld weights items"
  );
  await expect(
    handheldRestored.getByText("Adjustable dumbbells (5–35 lb pair)")
  ).toBeVisible();
  await expect(
    handheldRestored.getByText("Range: 5–35 lb", { exact: true })
  ).toBeVisible();
});

test("review setup walks through current saved state without touching the Program or setup completion", async ({
  page,
}) => {
  await installNextDevelopmentRefreshControl(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await signIn(page);
  await page.goto("/settings");
  const reviewSetup = page.getByRole("button", { name: "Review setup" });
  await waitForReactHandler(reviewSetup);
  await reviewSetup.click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Review setup", exact: true })
  ).toBeVisible();
  await expect(page.getByText(/· v\d+ ·/)).toBeVisible();
  await expect(page.getByText("Activate", { exact: false })).toHaveCount(0);

  // Review all: five sections with fixed destinations and no onboarding.
  const reviewAll = page.getByRole("button", {
    name: "Review all",
    exact: true,
  });
  await waitForReactHandler(reviewAll);
  await reviewAll.click();
  await expect(page).toHaveURL(/\/settings\/setup\/profile\?flow=all$/);
  await expect(page.getByText("step 1 of 5")).toBeVisible();
  await expect(
    page.getByText("The account unit is read-only here", { exact: false })
  ).toBeVisible();
  const continueProfile = page.getByRole("button", {
    name: "Continue without changes",
    exact: true,
  });
  await waitForReactHandler(continueProfile);
  await continueProfile.click();
  await expect(page).toHaveURL(/\/settings\/setup\/equipment\?flow=all$/);
  const continueEquipment = page.getByRole("button", {
    name: "Continue without changes",
    exact: true,
  });
  await waitForReactHandler(continueEquipment);
  await continueEquipment.click();
  await expect(page).toHaveURL(/\/settings\/setup\/constraints\?flow=all$/);
  const continueConstraints = page.getByRole("button", {
    name: "Continue without changes",
    exact: true,
  });
  await waitForReactHandler(continueConstraints);
  await continueConstraints.click();
  await expect(page).toHaveURL(/\/settings\/setup\/coaching\?flow=all$/);
  const continueCoaching = page.getByRole("button", {
    name: "Continue without changes",
    exact: true,
  });
  await waitForReactHandler(continueCoaching);
  await continueCoaching.click();
  await expect(page).toHaveURL(/\/settings\/setup\/program\?flow=all$/);
  await expect(page.getByText(/version \d+/)).toBeVisible();
  await expect(
    page.getByText("Reviewing your setup never changes the Program", {
      exact: false,
    })
  ).toBeVisible();
  const finishReview = page.getByRole("button", {
    name: "Finish review",
    exact: true,
  });
  await waitForReactHandler(finishReview);
  await finishReview.click();
  await expect(page).toHaveURL(/\/settings$/);

  // One isolated Profile change saves alone and is visible on the summary.
  await page.goto("/settings/setup/profile");
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  await waitForReactHandler(advanced);
  await advanced.click();
  const saveAdvanced = page.getByRole("button", {
    name: "Save and continue",
    exact: true,
  });
  await waitForReactHandler(saveAdvanced);
  await saveAdvanced.click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  await expect(page.getByText(/advanced · 4×\/week|advanced ·/)).toBeVisible();

  // Restore the seeded experience level.
  await page.goto("/settings/setup/profile");
  const intermediate = page.getByRole("button", {
    name: "Intermediate",
    exact: true,
  });
  await waitForReactHandler(intermediate);
  await intermediate.click();
  const saveIntermediate = page.getByRole("button", {
    name: "Save and continue",
    exact: true,
  });
  await waitForReactHandler(saveIntermediate);
  await saveIntermediate.click();
  await expect(page).toHaveURL(/\/settings\/setup$/);
  expect(browserErrors).toEqual([]);
});

test("restores the seeded plate and item display state through a confirmed capability-reducing save", async ({
  page,
}) => {
  await signIn(page);
  await openManager(page);
  const plateDrawer = await openPlateDrawer(page);
  const decrease45 = plateDrawer.getByRole("button", {
    name: "Decrease quantity of 45 lb plates",
  });
  await waitForReactHandler(decrease45);
  await decrease45.click();
  await plateDrawer
    .getByRole("button", { name: "Remove 1.25 lb plates", exact: true })
    .click();
  await saveDrawer(plateDrawer);
  const trapDrawer = await openItemDrawer(page, "Trap / hex bar");
  await trapDrawer
    .getByRole("button", { name: "Remove Trap / hex bar", exact: true })
    .click();
  const benchDrawer = await openItemDrawer(page, "Flat utility bench");
  await benchDrawer
    .getByRole("button", { name: "Remove Flat utility bench", exact: true })
    .click();
  await reviewChanges(page);
  await expect(page.getByText(/45 lb: 3 plates → 2 plates/)).toBeVisible();
  await expect(page.getByText(/1\.25 lb: removed/)).toBeVisible();
  await saveFromReview(page, true);

  const barsRegion = await expandSettingsFamily(
    page,
    /Bars & weight plates/,
    "Bars & weight plates items"
  );
  await expect(barsRegion.getByText("45 lb × 2", { exact: true })).toBeVisible();
  await expect(barsRegion.getByText(/1\.25 lb ×/)).toHaveCount(0);
  await expect(barsRegion.getByText("Trap / hex bar", { exact: true })).toHaveCount(0);
});

test("manager and setup review fit every supported text size at narrow and wide layouts", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await signIn(page);
  const sizes = ["Compact", "Default", "Large", "Extra large"];
  const viewports = [
    { width: 320, height: 850 },
    { width: 390, height: 850 },
    { width: 768, height: 900 },
    { width: 1440, height: 1000 },
  ];

  async function expectLayoutFits(label: string) {
    const result = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1))
        .slice(0, 5)
        .map(({ element, rect }) => ({
          text: element.textContent?.trim().slice(0, 50),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        })),
    }));
    expect(
      result.scrollWidth <= result.clientWidth + 1,
      `${label} overflowed: ${JSON.stringify(result.offenders)}`
    ).toBe(true);
  }

  for (const size of sizes) {
    await page.goto("/settings");
    const radio = page.getByRole("radio", { name: new RegExp(`^${size}`) });
    await waitForReactHandler(radio);
    if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
    await expect(radio).toHaveAttribute("aria-checked", "true");

    await page.goto("/settings/equipment");
    if (size === "Extra large") {
      await page.locator("html").evaluate((element) => element.classList.add("dark"));
      await expect(page.locator("html")).toHaveClass(/dark/);
    }
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await expectLayoutFits(`${size} manager at ${viewport.width}px`);
      await expect(page.getByRole("button", { name: "No changes to save" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      const unobscured = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        const sections = document.querySelectorAll<HTMLElement>(
          "#equipment-inventory-editor > section"
        );
        const lastSection = sections.item(sections.length - 1);
        const footer = document.querySelector<HTMLElement>(
          "[data-equipment-action-footer]"
        );
        if (!lastSection || !footer) return null;
        return {
          contentBottom: Math.round(lastSection.getBoundingClientRect().bottom),
          footerTop: Math.round(footer.getBoundingClientRect().top),
        };
      });
      expect(unobscured, `${size} manager missing its final content or footer`).not.toBeNull();
      expect(
        unobscured!.contentBottom <= unobscured!.footerTop,
        `${size} manager footer covered the final control at ${viewport.width}px: ${JSON.stringify(unobscured)}`
      ).toBe(true);
    }

    // At the requested 390 px mobile width, both drawers must remain usable at
    // every supported text size, including 145% and the dark palette.
    await page.setViewportSize({ width: 390, height: 844 });
    const itemDrawer = await openItemDrawer(page, "Olympic barbell (45 lb)");
    await expectLayoutFits(`${size} item drawer at 390px`);
    await expect(itemDrawer.getByRole("button", { name: "Save changes" })).toBeVisible();
    await itemDrawer.getByRole("button", { name: "Cancel", exact: true }).click();

    const plateDrawer = await openPlateDrawer(page);
    await expectLayoutFits(`${size} plate drawer at 390px`);
    await expect(plateDrawer.locator("#add-plate-weight")).toBeVisible();
    await expect(plateDrawer.getByRole("button", { name: "Save changes" })).toBeVisible();
    await plateDrawer.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.goto("/settings/setup");
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await expectLayoutFits(`${size} setup review at ${viewport.width}px`);
      await expect(page.getByRole("button", { name: "Review all" })).toBeVisible();
    }
  }

  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /^Default/ });
  await waitForReactHandler(defaultSize);
  if ((await defaultSize.getAttribute("aria-checked")) !== "true") {
    await defaultSize.click();
  }
  await expect(defaultSize).toHaveAttribute("aria-checked", "true");
  expect(browserErrors).toEqual([]);
});

test("stays usable at 320 px and extra-large text with keyboard-driven steppers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await signIn(page);
  await page.goto("/settings");
  const extraLarge = page.getByRole("radio", { name: /Extra large/ });
  await waitForReactHandler(extraLarge);
  await extraLarge.click();
  await expect(extraLarge).toHaveAttribute("aria-checked", "true");

  await page.goto("/settings/equipment");
  await expect(
    page.getByRole("heading", { name: "Manage equipment", exact: true })
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      )
    )
    .toBeLessThanOrEqual(1);
  await expect(
    page.getByRole("button", { name: "No changes to save", exact: true })
  ).toBeVisible();
  const undersizedTargets = await page.locator("#equipment-inventory-editor button:visible").evaluateAll(
    (buttons) =>
      buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.getAttribute("aria-label") ?? button.textContent, width: rect.width, height: rect.height };
        })
        .filter((target) => target.width < 44 || target.height < 44)
  );
  expect(undersizedTargets).toEqual([]);

  // Keyboard path: the quantity stepper works with focus + Enter in the plate
  // drawer, and an inverse staged edit returns the page to a clean state.
  const plateDrawer = await openPlateDrawer(page);
  const increase45 = plateDrawer.getByRole("button", {
    name: "Increase quantity of 45 lb plates",
  });
  await waitForReactHandler(increase45);
  await increase45.focus();
  await page.keyboard.press("Enter");
  await expect(
    plateDrawer.getByRole("spinbutton", { name: "Quantity of 45 lb plates", exact: true })
  ).toHaveValue("3");
  await saveDrawer(plateDrawer);
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true })
  ).toBeEnabled();
  const restoredPlateDrawer = await openPlateDrawer(page);
  const decrease45 = restoredPlateDrawer.getByRole("button", {
    name: "Decrease quantity of 45 lb plates",
  });
  await decrease45.focus();
  await page.keyboard.press("Enter");
  await saveDrawer(restoredPlateDrawer);
  await expect(
    page.getByRole("button", { name: "No changes to save", exact: true })
  ).toBeDisabled();

  // The add-equipment dialog traps focus and closes with Escape.
  await page.getByRole("button", { name: "Add equipment", exact: true }).click();
  await expect(page.getByLabel("Search equipment types")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Search equipment types")).toHaveCount(0);

  // Restore the default app size for the later suite flows.
  await page.goto("/settings");
  const defaultSize = page.getByRole("radio", { name: /Default/ });
  await waitForReactHandler(defaultSize);
  await defaultSize.click();
  await expect(defaultSize).toHaveAttribute("aria-checked", "true");
});
