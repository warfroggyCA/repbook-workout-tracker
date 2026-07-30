import { describe, expect, it } from "vitest";
import { contextualNoteCreateInputSchema } from "@/lib/contextual-note-contract";

const base = {
  clientKey: "60000000-0000-4000-8000-000000000095",
  body: "Reviewed observation",
  inputMode: "reviewed_dictation" as const,
  recordedAt: "2026-07-22T16:10:00.000Z",
  attachmentKind: "general" as const,
  capturedContext: {
    schemaVersion: 1 as const,
    destination: "today" as const,
    workflow: null,
    workoutPhase: null,
    originatedFromSimulation: false,
    programDay: null,
    plannedExercise: null,
    performedExercise: null,
    occurrence: null,
    loadRepetitions: null,
    restContext: { plannedSeconds: 90, remainingSeconds: 12, state: "resting" as const },
    reviewContext: null,
  },
};

describe("contextual note input contract", () => {
  it("defaults Coach visibility and retains explicit rest-before-next-set context", () => {
    expect(contextualNoteCreateInputSchema.parse(base)).toMatchObject({
      coachVisible: true,
      capturedContext: {
        restContext: { plannedSeconds: 90, remainingSeconds: 12, state: "resting" },
      },
    });
  });

  it("rejects raw audio and incomplete load/unit snapshots", () => {
    expect(() => contextualNoteCreateInputSchema.parse({ ...base, rawAudio: "never durable" })).toThrow();
    expect(() => contextualNoteCreateInputSchema.parse({
      ...base,
      capturedContext: {
        ...base.capturedContext,
        loadRepetitions: { performedLoad: 100 },
      },
    })).toThrow(/performed load and unit/i);
  });

  it("requires rest notes to name the exact acknowledged result", () => {
    const restBase = {
      ...base,
      attachmentKind: "rest" as const,
      sessionId: "10000000-0000-4000-8000-000000000001",
      sessionExerciseId: "20000000-0000-4000-8000-000000000002",
      occurrenceId: "30000000-0000-4000-8000-000000000003",
    };
    expect(() => contextualNoteCreateInputSchema.parse(restBase)).toThrow();
    expect(contextualNoteCreateInputSchema.parse({
      ...restBase,
      completedSetId: "40000000-0000-4000-8000-000000000004",
    })).toMatchObject({
      attachmentKind: "rest",
      completedSetId: "40000000-0000-4000-8000-000000000004",
    });
  });
});
