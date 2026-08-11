import { describe, expect, it } from "vitest";
import { parseCanonicalRoutineText } from "@/ai/tasks/routine-parse/deterministic";
import {
  buildRoutineImportStagePayload,
  readRoutineImportStagePayload,
} from "@/services/routine-import";

describe("routine import staged review identity", () => {
  it("binds the exact normalized package, mapping, and active Program base", () => {
    const envelope = parseCanonicalRoutineText(`Program: Stage proof
Day 1 — Strength
Warm-up: Easy bike | load=5 minutes
Bench Press 3x8 @ 135 lb, rest 2 min
Ramp-up: Empty bar | reps=10`);
    expect(envelope).not.toBeNull();
    const baseProgramVersionId = "10000000-0000-4000-8000-000000000001";
    const exerciseId = "10000000-0000-4000-8000-000000000002";
    const payload = buildRoutineImportStagePayload({
      schemaVersion: "routine-import-stage/1",
      envelope: envelope!,
      mappings: [
        {
          rawName: "Bench Press",
          exerciseId,
          exerciseName: "Barbell Bench Press",
          matchType: "alias",
          candidates: [{ id: exerciseId, name: "Barbell Bench Press" }],
        },
      ],
      parserVersion: "canonical-routine-text/2",
      aiEventIds: { routineParse: null, exerciseMap: null },
      baseProgramVersionId,
    });

    expect(readRoutineImportStagePayload(payload)).toEqual(payload);
    expect(payload.stageDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(payload.envelope.data.days[0]?.warmupItems).toEqual([
      expect.objectContaining({
        label: "Easy bike",
        beforeSlotLineageId: null,
      }),
      expect.objectContaining({
        label: "Empty bar",
        beforeSlotLineageId:
          payload.envelope.data.days[0]?.exercises[0]?.lineageId,
      }),
    ]);
  });

  it("rejects a changed payload that reuses the old stage digest", () => {
    const envelope = parseCanonicalRoutineText(`Program: Stage proof
Day 1 — Strength
Bench Press 3x8 @ 135 lb, rest 2 min`)!;
    const payload = buildRoutineImportStagePayload({
      schemaVersion: "routine-import-stage/1",
      envelope,
      mappings: [],
      parserVersion: "canonical-routine-text/2",
      aiEventIds: { routineParse: null, exerciseMap: null },
      baseProgramVersionId: null,
    });

    expect(
      readRoutineImportStagePayload({
        ...payload,
        parserVersion: "changed-after-review",
      }),
    ).toBeNull();
  });
});
