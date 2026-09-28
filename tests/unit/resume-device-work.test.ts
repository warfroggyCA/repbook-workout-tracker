import { describe, expect, it } from "vitest";
import {
  describeSessionDeviceWork,
  NO_SESSION_DEVICE_WORK,
  sessionDeviceWorkIsClear,
  summarizeSessionDeviceWork,
  UNAVAILABLE_SESSION_DEVICE_WORK,
} from "@/lib/resume-device-work";

const OWNER = "20000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "20000000-0000-4000-8000-000000000002";
const SESSION = "10000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "10000000-0000-4000-8000-000000000002";

type Status = "queued" | "needs_attention";
function copy(sessionId = SESSION, status: Status = "queued", ownerId = OWNER) {
  return { ownerId, sessionId, status };
}
function summarize(input: {
  sets?: ReturnType<typeof copy>[];
  changes?: ReturnType<typeof copy>[];
  quarantined?: number;
  setError?: string | null;
  changeError?: string | null;
}) {
  return summarizeSessionDeviceWork({
    ownerId: OWNER,
    sessionId: SESSION,
    sets: {
      entries: (input.sets ?? []) as never,
      quarantined: Array.from({ length: input.quarantined ?? 0 }, (_, index) => ({
        quarantineKey: `entries:${index}`,
        raw: { unreadable: true },
        reason: "This saved workout set is incomplete or invalid.",
      })),
      error: input.setError ?? null,
    },
    changes: {
      entries: (input.changes ?? []) as never,
      error: input.changeError ?? null,
    },
  });
}

describe("summarizeSessionDeviceWork", () => {
  it("counts only this owner's sets and workout changes for the resumed session", () => {
    const work = summarize({
      sets: [
        copy(),
        copy(SESSION, "needs_attention"),
        copy(OTHER_SESSION),
        copy(SESSION, "queued", OTHER_OWNER),
      ],
      changes: [copy(), copy(OTHER_SESSION, "needs_attention")],
    });
    expect(work).toEqual({
      ...NO_SESSION_DEVICE_WORK,
      savingSets: 1,
      attentionSets: 1,
      savingChanges: 1,
    });
  });

  it("is clear only when both queues were read and hold nothing for the session", () => {
    const work = summarize({ sets: [copy(OTHER_SESSION)] });
    expect(sessionDeviceWorkIsClear(work)).toBe(true);
    expect(describeSessionDeviceWork(work)).toEqual({
      state: "clear",
      title: "No sets or workout changes from this workout are waiting on this device",
      detail: "",
    });
  });
});

describe("fail-closed device evidence", () => {
  it.each([
    ["an unreadable set queue", { setError: "The saved workout set queue on this device could not be read. It was left unchanged." }, "The list of sets saved on this device could not be read."],
    ["an unreadable workout-change queue", { changeError: "The saved workout-item queue contains an invalid device copy. It was left unchanged." }, "The list of workout changes saved on this device could not be read."],
    ["a quarantined set copy", { quarantined: 1 }, "1 set copy on this device could not be read and may belong to this workout."],
    ["several quarantined set copies", { quarantined: 2 }, "2 set copies on this device could not be read and may belong to this workout."],
  ] as const)("never reports nothing waiting with %s", (_label, input, reason) => {
    const work = summarize(input);
    expect(sessionDeviceWorkIsClear(work)).toBe(false);
    const description = describeSessionDeviceWork(work);
    expect(description.state).toBe("unknown");
    expect(description.title).toBe(
      "Repbook can't confirm what's waiting on this device",
    );
    expect(description.detail).toContain(reason);
    expect(description.title).not.toMatch(/No sets|Nothing/);
  });

  it("treats refused device storage as unknown rather than empty", () => {
    expect(sessionDeviceWorkIsClear(UNAVAILABLE_SESSION_DEVICE_WORK)).toBe(false);
    expect(describeSessionDeviceWork(UNAVAILABLE_SESSION_DEVICE_WORK).detail).toContain(
      "This browser would not open this device's saved workout copies.",
    );
  });

  it("keeps readable pending work visible alongside unknown evidence", () => {
    const description = describeSessionDeviceWork(
      summarize({ sets: [copy(), copy(SESSION, "needs_attention")], quarantined: 1 }),
    );
    expect(description.state).toBe("unknown");
    expect(description.detail).toContain("1 set needs attention.");
    expect(description.detail).toContain("1 set still saving.");
  });
});

describe("describeSessionDeviceWork", () => {
  it("describes saving work neutrally, naming only the kinds it checks", () => {
    expect(describeSessionDeviceWork({ ...NO_SESSION_DEVICE_WORK, savingSets: 1 })).toEqual({
      state: "saving",
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
      state: "attention",
      title: "1 set needs attention on this device",
      detail: "1 set also still saving. Resume to retry or discard the device copy.",
    });
    expect(
      describeSessionDeviceWork({ ...NO_SESSION_DEVICE_WORK, attentionSets: 2 }),
    ).toEqual({
      state: "attention",
      title: "2 sets need attention on this device",
      detail: "Resume to retry or discard the device copies.",
    });
  });
});
