import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/actions/import", () => ({
  parseRoutineText: vi.fn(),
  confirmImport: vi.fn(),
  discardImport: vi.fn(),
}));

import { parseCanonicalRoutineText } from "@/ai/tasks/routine-parse/deterministic";
import { RoutineImport } from "@/components/import/routine-import";

describe("Program paste review", () => {
  it("renders bounded paste guidance before parsing", () => {
    const html = renderToStaticMarkup(
      <RoutineImport aiAvailable={false} />,
    );

    expect(html).toContain("Paste your Program");
    expect(html).toContain("20,000 characters");
    expect(html).toContain("General preparation and lift ramp-ups");
    expect(html).toContain("Exercise notes stay with that movement");
    expect(html).toContain("Parse for review");
  });

  it("shows every warm-up with timing controls and honest editable intent", () => {
    const envelope = parseCanonicalRoutineText(`Program: Review proof
Day 1 — Strength
Warm-up: Easy bike | load=5 minutes
Bench Press 3x8 @ 135 lb, rest 2 min
Ramp-up: Empty bar | reps=10`)!;
    const exerciseId = "10000000-0000-4000-8000-000000000001";
    const html = renderToStaticMarkup(
      <RoutineImport
        aiAvailable
        initialParse={{
          ok: true,
          importEventId: "10000000-0000-4000-8000-000000000002",
          stageDigest: "a".repeat(64),
          baseProgramVersionId: null,
          envelope,
          mappings: [{
            rawName: "Bench Press",
            exerciseId,
            exerciseName: "Barbell Bench Press",
            matchType: "alias",
            candidates: [{ id: exerciseId, name: "Barbell Bench Press" }],
          }],
          library: [{
            id: exerciseId,
            familyId: null,
            name: "Barbell Bench Press",
            activityClass: "strength",
            movementPattern: "horizontal_push",
            family: null,
            loadType: "barbell",
            metricType: "weight_reps",
            loadSemantics: "total",
            variantAttributes: {},
            primaryMuscles: ["chest"],
            secondaryMuscles: [],
            equipment: ["barbell"],
            available: true,
            missing: [],
            constraintBlocked: false,
            unavailableReason: null,
            cautionBodyParts: [],
            media: null,
          }],
        }}
      />,
    );

    expect(html).toContain("Checkable warm-up timeline");
    expect(html).toContain("Easy bike");
    expect(html).toContain("Empty bar");
    expect(html).toContain("At the start of the workout");
    expect(html).toContain("Before Bench Press");
    expect(html).toContain("Include step 1");
    expect(html).toContain("Day 1 — Strength, warm-up 2, Empty bar, remove");
    expect(html).toContain("Day 1 — Strength, warm-up 2, Empty bar, instruction");
    expect(html).toContain("Day 1 — Strength, Bench Press, planned sets");
    expect(html).toContain("What a shorter-session request actually does");
    expect(html).toContain("Essential — do not reduce");
    expect(html).toContain("Minimum useful sets");
    expect(html).toContain("Automatic replacement: off");
    expect(html).toContain("Confirm exact equipment fit");
    expect(html).not.toContain("approved_family");
    expect(html).not.toContain("omissionPolicy");
  });

  it("labels paired rest by the exact point where execution uses it", () => {
    const envelope = parseCanonicalRoutineText(`Program: Paired timing proof
Day 1 — Pair
A1 Bench Press 3x8, rest 30 sec
A2 Push-up 3x10, rest 60 sec`)!;
    envelope.data.days[0]!.exercises[0]!.reps = {
      kind: "perSet",
      perSet: [8, 8, 6],
    };
    const exerciseId = "10000000-0000-4000-8000-000000000001";
    const mappings = envelope.data.days[0]!.exercises.map((exercise) => ({
      rawName: exercise.rawName,
      exerciseId,
      exerciseName: "Barbell Bench Press",
      matchType: "exact" as const,
      candidates: [{ id: exerciseId, name: "Barbell Bench Press" }],
    }));
    const html = renderToStaticMarkup(
      <RoutineImport
        aiAvailable={false}
        initialParse={{
          ok: true,
          importEventId: "10000000-0000-4000-8000-000000000002",
          stageDigest: "b".repeat(64),
          baseProgramVersionId: null,
          envelope,
          mappings,
          library: [{
            id: exerciseId,
            familyId: null,
            name: "Barbell Bench Press",
            activityClass: "strength",
            movementPattern: "horizontal_push",
            family: null,
            loadType: "barbell",
            metricType: "weight_reps",
            loadSemantics: "total",
            variantAttributes: {},
            primaryMuscles: ["chest"],
            secondaryMuscles: [],
            equipment: ["barbell"],
            available: true,
            missing: [],
            constraintBlocked: false,
            unavailableReason: null,
            cautionBodyParts: [],
            media: null,
          }],
        }}
      />,
    );

    expect(html).toContain("Rest before next paired exercise (seconds)");
    expect(html).toContain("Rest after each paired round (seconds)");
    expect(html).toContain("Bench Press, rest before next paired exercise");
    expect(html).toContain("Push-up, rest after each paired round");
    expect(html).toContain("Authored set targets: 8 / 8 / 6");
    expect(html).toContain("cannot store different rep targets for individual sets");
  });
});
