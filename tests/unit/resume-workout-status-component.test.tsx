import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  readSessionDeviceWork,
  ResumeWorkoutStatus,
} from "@/components/dashboard/resume-workout-status";
import {
  NO_SESSION_DEVICE_WORK,
  sessionDeviceWorkIsClear,
} from "@/lib/resume-device-work";

const OWNER = "20000000-0000-4000-8000-000000000001";
const SESSION = "30000000-0000-4000-8000-000000000001";
const EMPTY_SETS = { entries: [], quarantined: [], error: null };
const EMPTY_CHANGES = { entries: [], error: null };

describe("ResumeWorkoutStatus", () => {
  it("claims nothing about saving or the next step before this device is read", () => {
    const html = renderToStaticMarkup(
      <ResumeWorkoutStatus
        ownerId={OWNER}
        sessionId={SESSION}
        upNext={{ title: "Barbell Back Squat · set 2", detail: "6–8 reps · 95 lb" }}
      />,
    );
    expect(html).toBe("");
  });
});

describe("readSessionDeviceWork", () => {
  it("reads two empty, readable queues as clear", () => {
    const work = readSessionDeviceWork(OWNER, SESSION, {
      storageAvailable: () => true,
      sets: () => EMPTY_SETS,
      changes: () => EMPTY_CHANGES,
    });
    expect(work).toEqual(NO_SESSION_DEVICE_WORK);
    expect(sessionDeviceWorkIsClear(work)).toBe(true);
  });

  it("does not mistake refused storage for empty queues", () => {
    const work = readSessionDeviceWork(OWNER, SESSION, {
      storageAvailable: () => false,
      sets: () => EMPTY_SETS,
      changes: () => EMPTY_CHANGES,
    });
    expect(work.storageUnavailable).toBe(true);
    expect(sessionDeviceWorkIsClear(work)).toBe(false);
  });

  it("fails closed when a queue reader throws", () => {
    const work = readSessionDeviceWork(OWNER, SESSION, {
      storageAvailable: () => true,
      sets: () => {
        throw new Error("synthetic storage failure");
      },
      changes: () => EMPTY_CHANGES,
    });
    expect(sessionDeviceWorkIsClear(work)).toBe(false);
  });
});
