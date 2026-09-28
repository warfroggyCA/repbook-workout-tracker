import { describe, expect, it } from "vitest";
import type { WorkoutCommand } from "@/lib/workout-command-queue";
import {
  describeSessionDeviceWork,
  hasSessionDeviceWork,
  NO_SESSION_DEVICE_WORK,
  summarizeSessionDeviceWork,
} from "@/lib/resume-device-work";

const SESSION = "10000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "10000000-0000-4000-8000-000000000002";

function command(
  kind: WorkoutCommand["kind"],
  sessionId: string,
  status: "queued" | "needs_attention" = "queued",
) {
  return {
    kind,
    entry: { sessionId, status, ownerId: "owner", clientKey: `${kind}-${sessionId}-${status}`, createdAtISO: "2026-09-28T12:00:00.000Z" },
  } as unknown as WorkoutCommand;
}

describe("summarizeSessionDeviceWork", () => {
  it("counts only recorded work for the resumed session", () => {
    const summary = summarizeSessionDeviceWork(
      [
        command("set", SESSION),
        command("set", SESSION, "needs_attention"),
        command("occurrence", SESSION),
        command("set", OTHER_SESSION),
        command("selection", SESSION),
        command("note", SESSION),
        command("coach", SESSION),
      ],
      SESSION,
    );
    expect(summary).toEqual({
      savingSets: 1,
      attentionSets: 1,
      savingChanges: 1,
      attentionChanges: 0,
    });
  });

  it("reports nothing waiting when the device holds no work for the session", () => {
    const summary = summarizeSessionDeviceWork(
      [command("set", OTHER_SESSION), command("selection", SESSION)],
      SESSION,
    );
    expect(summary).toEqual(NO_SESSION_DEVICE_WORK);
    expect(hasSessionDeviceWork(summary)).toBe(false);
    expect(describeSessionDeviceWork(summary)).toEqual({
      tone: "neutral",
      title: "Nothing from this workout is waiting on this device",
      detail: "",
    });
  });
});

describe("describeSessionDeviceWork", () => {
  it("describes saving work neutrally", () => {
    expect(
      describeSessionDeviceWork({ ...NO_SESSION_DEVICE_WORK, savingSets: 1 }),
    ).toEqual({
      tone: "neutral",
      title: "1 set still saving from this device",
      detail: "Open the workout to finish saving and see where you are.",
    });
    expect(
      describeSessionDeviceWork({
        ...NO_SESSION_DEVICE_WORK,
        savingSets: 2,
        savingChanges: 1,
      }).title,
    ).toBe("2 sets and 1 workout change still saving from this device");
  });

  it("puts failed work first and keeps saving work visible", () => {
    expect(
      describeSessionDeviceWork({
        ...NO_SESSION_DEVICE_WORK,
        attentionSets: 1,
        savingSets: 1,
      }),
    ).toEqual({
      tone: "attention",
      title: "1 set needs attention on this device",
      detail:
        "1 set also still saving. Resume to retry or discard the device copy.",
    });
    expect(
      describeSessionDeviceWork({
        ...NO_SESSION_DEVICE_WORK,
        attentionSets: 2,
      }).title,
    ).toBe("2 sets need attention on this device");
  });
});
