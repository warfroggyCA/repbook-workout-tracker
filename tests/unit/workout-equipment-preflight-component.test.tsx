import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkoutEquipmentPreflight } from "@/components/dashboard/workout-equipment-preflight";
import type { SessionPreparationEquipmentProjection } from "@/lib/session-equipment-requirements";

function projection(
  overrides: Partial<SessionPreparationEquipmentProjection> = {},
): SessionPreparationEquipmentProjection {
  return {
    state: "unavailable",
    statusText: "Some requirements are unavailable or have no compatible saved setup.",
    evidenceState: "retained",
    sourceHistoryRevision: null,
    rows: [{
      key: "type:dumbbell",
      label: "dumbbells",
      classification: "attention",
      status: "unavailable",
      statusText: "Unavailable in saved equipment",
      usageContext: "Used for Synthetic press",
      equipmentType: "dumbbell",
      equipmentDefinitionId: null,
      requiredProfileKind: null,
      requiredAttachmentKind: null,
      requiresKnownGeometry: false,
      minWeight: 20,
      sourceExerciseIds: ["84a4edbe-e0c4-46df-ae57-e847ae17b4f3"],
      sourceRequirementIds: ["80dfe8bc-2244-4187-b2ce-9c4c24a930f8"],
    }],
    ...overrides,
  };
}

describe("WorkoutEquipmentPreflight", () => {
  it("links attention to saved equipment without disabling Start", () => {
    const html = renderToStaticMarkup(
      <WorkoutEquipmentPreflight projection={projection()} />,
    );

    expect(html).toContain('data-testid="workout-equipment-preflight"');
    expect(html).toContain('href="/settings/equipment"');
    expect(html).toContain("1 equipment item needs attention");
    expect(html).toContain("this does not block the workout");
    expect(html).not.toContain("disabled");
  });

  it("keeps unknown distinct and stays absent when all equipment is available", () => {
    const unknown = renderToStaticMarkup(
      <WorkoutEquipmentPreflight
        projection={projection({
          state: "unknown",
          evidenceState: "unknown",
          statusText: "Equipment requirements are unavailable.",
          rows: [],
        })}
      />,
    );
    const available = renderToStaticMarkup(
      <WorkoutEquipmentPreflight
        projection={projection({
          state: "available",
          statusText: "Saved equipment covers this workout.",
          rows: [],
        })}
      />,
    );

    expect(unknown).toContain("Equipment check unavailable");
    expect(available).toBe("");
  });
});
