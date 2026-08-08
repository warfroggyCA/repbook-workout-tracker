import { describe, expect, it } from "vitest";
import {
  classifyPainHold,
  type PainHoldEvidence,
} from "@/engine/progression/pain-hold";

const now = new Date("2026-07-30T16:00:00.000Z");

function evidence(
  id: string,
  severity: number | null,
  createdAt: string,
  sessionId: string | null = `session-${id}`
): PainHoldEvidence {
  return { id, severity, createdAt: new Date(createdAt), sessionId };
}

function classify(entries: PainHoldEvidence[]) {
  return classifyPainHold({
    exerciseName: "Barbell Back Squat",
    now,
    evidence: entries,
  });
}

describe("classifyPainHold", () => {
  it("holds for a recent 3/10 flag and explains the recording-time release rule", () => {
    const result = classify([
      evidence("pain-1", 3, "2026-07-25T12:00:00.000Z"),
    ]);

    expect(result).toMatchObject({
      state: "hold",
      blocksProgression: true,
      evidenceIds: ["pain-1"],
      sessionIds: ["session-pain-1"],
      signals: {
        windowDays: 14,
        positiveReports: 1,
        holdReports: 1,
        triggerEvidenceId: "pain-1",
      },
    });
    expect(result.releaseAt?.toISOString()).toBe("2026-08-08T12:00:00.000Z");
    expect(result.explanation).toContain(
      "It comes off hold 14 days after the latest 3/10 or higher report."
    );
    expect(result.explanation).toContain(
      "A workout with no pain entry doesn't shorten that time."
    );
  });

  it("requests an alternative review for a 5/10 flag without diagnostic language", () => {
    const result = classify([
      evidence("pain-5", 5, "2026-07-29T10:00:00.000Z"),
    ]);

    expect(result.state).toBe("substitution_review");
    expect(result.signals.highSeverityReview).toBe(true);
    expect(result.explanation).toBe(
      "Barbell Back Squat needs an alternative review because a 5/10 positive pain report was saved in the last 14 days. " +
        "The pain hold clears 14 days after the latest 3/10 or higher report. " +
        "A workout with no pain entry doesn't shorten that time."
    );
  });

  it("requests an alternative review when positive flags span three linked workouts", () => {
    const result = classify([
      evidence("pain-1", 1, "2026-07-21T10:00:00.000Z", "session-a"),
      evidence("pain-2", 2, "2026-07-24T10:00:00.000Z", "session-b"),
      evidence("pain-3", 1, "2026-07-28T10:00:00.000Z", "session-c"),
    ]);

    expect(result).toMatchObject({
      state: "substitution_review",
      releaseAt: null,
      signals: {
        linkedSessions: 3,
        repeatedSessionReview: true,
        highSeverityReview: false,
      },
    });
    expect(result.explanation).toContain(
      "positive pain was reported in 3 workouts in the last 14 days"
    );
    expect(result.explanation).toContain(
      "Progression stays paused while those reports are in the 14-day window."
    );
  });

  it("does not treat missing, zero, or unlinked entries as recurrence or early release", () => {
    const result = classify([
      evidence("hold", 4, "2026-07-20T10:00:00.000Z", "session-a"),
      evidence("missing", null, "2026-07-28T10:00:00.000Z", "session-b"),
      evidence("zero", 0, "2026-07-29T10:00:00.000Z", "session-c"),
      evidence("unlinked", 2, "2026-07-29T12:00:00.000Z", null),
    ]);

    expect(result.state).toBe("hold");
    expect(result.evidenceIds).toEqual(["hold", "unlinked"]);
    expect(result.sessionIds).toEqual(["session-a"]);
    expect(result.releaseAt?.toISOString()).toBe("2026-08-03T10:00:00.000Z");
    expect(result.signals).toMatchObject({
      positiveReports: 2,
      holdReports: 1,
      linkedSessions: 1,
      repeatedSessionReview: false,
    });
  });

  it("uses severity, recording time, then stable id for deterministic trigger ordering", () => {
    const result = classify([
      evidence("pain-z", 4, "2026-07-29T12:00:00.000Z", "session-z"),
      evidence("pain-b", 5, "2026-07-28T12:00:00.000Z", "session-b"),
      evidence("pain-a", 5, "2026-07-28T12:00:00.000Z", "session-a"),
      evidence("pain-newer", 4, "2026-07-30T12:00:00.000Z", "session-newer"),
    ]);

    expect(result.evidenceIds).toEqual([
      "pain-a",
      "pain-b",
      "pain-newer",
      "pain-z",
    ]);
    expect(result.signals.triggerEvidenceId).toBe("pain-a");
    expect(result.signals.triggerSessionId).toBe("session-a");
  });

  it("counts same-session duplicates as one linked workout", () => {
    const result = classify([
      evidence("pain-a", 1, "2026-07-26T10:00:00.000Z", "session-a"),
      evidence("pain-b", 2, "2026-07-27T10:00:00.000Z", "session-a"),
      evidence("pain-c", 1, "2026-07-28T10:00:00.000Z", "session-b"),
    ]);

    expect(result.state).toBe("clear");
    expect(result.signals).toMatchObject({
      positiveReports: 3,
      linkedSessions: 2,
      repeatedSessionReview: false,
    });
  });

  it("uses the latest 3/10-or-higher recording as the release boundary", () => {
    const result = classify([
      evidence("higher-old", 5, "2026-07-20T10:00:00.000Z", "session-a"),
      evidence("newer", 3, "2026-07-29T11:00:00.000Z", "session-b"),
      evidence("missing-newest", null, "2026-07-30T12:00:00.000Z", "session-c"),
    ]);

    expect(result.releaseAt?.toISOString()).toBe("2026-08-12T11:00:00.000Z");
  });

  it("expires evidence at the exact 14-day recording-time boundary", () => {
    const result = classify([
      evidence("expired", 5, "2026-07-16T16:00:00.000Z"),
      evidence("inside", 3, "2026-07-16T16:00:00.001Z"),
      evidence("future", 5, "2026-07-30T16:00:00.001Z"),
    ]);

    expect(result.state).toBe("hold");
    expect(result.evidenceIds).toEqual(["inside"]);
    expect(result.releaseAt?.toISOString()).toBe("2026-07-30T16:00:00.001Z");
  });

  it("returns a clear structured state when no positive evidence is active", () => {
    const result = classify([
      evidence("missing", null, "2026-07-29T10:00:00.000Z"),
      evidence("zero", 0, "2026-07-29T11:00:00.000Z"),
      evidence("negative", -1, "2026-07-29T12:00:00.000Z"),
    ]);

    expect(result).toMatchObject({
      state: "clear",
      blocksProgression: false,
      explanation: null,
      evidenceIds: [],
      sessionIds: [],
      releaseAt: null,
      signals: {
        positiveReports: 0,
        holdReports: 0,
        linkedSessions: 0,
        worstSeverity: null,
        triggerEvidenceId: null,
        triggerSessionId: null,
        highSeverityReview: false,
        repeatedSessionReview: false,
      },
    });
  });
});
