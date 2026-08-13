import type { Page } from "@playwright/test";

const WORKOUT_FINISH_BUTTON_NAME =
  /^(?:Review workout finish|Finish workout)$/;

export function getWorkoutFinishButton(page: Page) {
  return page
    .getByRole("complementary", { name: "Workout status" })
    .getByRole("button", { name: WORKOUT_FINISH_BUTTON_NAME });
}
