import { describe, expect, it } from "vitest";
import { restoreAcknowledgedSet } from "@/lib/session-runner";
import type { LoggedSet } from "@/components/session/types";

const restored: LoggedSet = {
  id: "saved-first", clientKey: "first-command", occurrenceId: "first-occurrence",
  setNo: 1, weight: 95, weightUnit: "lb", reps: 8, rpe: 7,
  note: "Keep this exact note.", correctionCount: 2, saveState: "saved",
};

describe("acknowledged archive undo projection", () => {
  it("restores exact saved measurements and identity without mutating the source", () => {
    const current: LoggedSet[] = [];
    expect(restoreAcknowledgedSet(current, restored)).toEqual([restored]);
    expect(current).toEqual([]);
  });

  it("keeps sets logged or queued while the Undo notification was open", () => {
    const later = { ...restored, id: "saved-second", clientKey: "second-command", setNo: 2, weight: 105, reps: 9 };
    const pending = { ...restored, id: "outbox-third", clientKey: "third-command", setNo: 3, saveState: "pending" as const };
    const current = [later, pending];
    const result = restoreAcknowledgedSet(current, restored);
    expect(result).toEqual([restored, later, pending]);
    expect(result[1]).toBe(later);
    expect(result[2]).toBe(pending);
    expect(current).toEqual([later, pending]);
  });

  it("does not duplicate a restored result or overwrite a newer correction", () => {
    const corrected = { ...restored, reps: 10, correctionCount: 3 };
    const current = [corrected];
    expect(restoreAcknowledgedSet(current, restored)).toBe(current);
    expect(current[0]).toBe(corrected);
  });

  it("does not duplicate a device command that is already represented", () => {
    const current = [{ ...restored, id: "existing-projection" }];
    expect(restoreAcknowledgedSet(current, restored)).toBe(current);
  });
});
