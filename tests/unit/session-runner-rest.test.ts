import { describe, expect, it } from "vitest";
import { restTimerSecondsAfterQueuedSet } from "@/lib/session-runner";

describe("active-workout rest timer destination", () => {
  it("keeps prescribed rest when another workout action remains", () => {
    expect(
      restTimerSecondsAfterQueuedSet({
        plannedRestSeconds: 90,
        pendingActionCount: 2,
      }),
    ).toBe(90);
  });

  it("suppresses rest when the queued set is the final pending action", () => {
    expect(
      restTimerSecondsAfterQueuedSet({
        plannedRestSeconds: 90,
        pendingActionCount: 1,
      }),
    ).toBeNull();
  });
});
