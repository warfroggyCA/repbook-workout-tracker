import { describe, expect, it } from "vitest";
import {
  parseSessionEquipmentRequirementsEvidence,
  projectSessionEquipmentPreparation,
  retainedAttachmentRequirementHasSavedSetup,
  retainedExactRequirementRowHasSavedSetup,
  retainedExerciseHasExecutableSetup,
  retainedPrimaryEquipmentCandidateMatchesBroad,
  retainedPrimaryRequirementRowHasSavedSetup,
  type RetainedExecutableSetupCandidate,
  type RetainedSavedAttachmentItem,
  type SessionEquipmentRequirementsSnapshot,
} from "@/lib/session-equipment-requirements";

const EXERCISE_A = "11111111-1111-4111-8111-111111111111";
const EXERCISE_B = "22222222-2222-4222-8222-222222222222";
const SESSION_A = "33333333-3333-4333-8333-333333333333";
const SESSION_B = "44444444-4444-4444-8444-444444444444";
const REQUIREMENT_A = "55555555-5555-4555-8555-555555555555";
const REQUIREMENT_B = "66666666-6666-4666-8666-666666666666";
const EXACT_A = "77777777-7777-4777-8777-777777777777";
const BAR = "88888888-8888-4888-8888-888888888888";
const ROPE = "99999999-9999-4999-8999-999999999999";
const OTHER_BAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ROPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function snapshot(
  exerciseId: string,
  requirementId: string,
  definitionId: string,
): SessionEquipmentRequirementsSnapshot {
  return {
    sourceExerciseId: exerciseId,
    broad: [{
      sourceRequirementId: requirementId,
      equipmentType: "barbell",
      equipmentDefinition: {
        id: definitionId,
        key: `bar-${definitionId}`,
        label: "Main bar",
      },
      minWeight: exerciseId === EXERCISE_A ? 45 : 55,
    }],
    exact: exerciseId === EXERCISE_A ? {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "plate_loaded_implement",
      requiredEquipmentDefinition: {
        id: definitionId,
        key: `bar-${definitionId}`,
        label: "Main bar",
      },
      requiredAttachmentKind: "rope",
      requiredAttachmentDefinition: {
        id: ROPE,
        key: "rope",
        label: "Rope attachment",
      },
      requiresKnownGeometry: true,
    } : null,
  };
}

describe("retained session equipment requirement contract", () => {
  it("deduplicates only by stable identity and retains provenance and exact cues", () => {
    const projection = projectSessionEquipmentPreparation([
      {
        sessionExerciseId: SESSION_B,
        exerciseId: EXERCISE_B,
        exerciseLabel: "Second exercise",
        orderIdx: 1,
        semanticsVersion: 1,
        snapshot: snapshot(EXERCISE_B, REQUIREMENT_B, BAR),
      },
      {
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "First exercise",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot: snapshot(EXERCISE_A, REQUIREMENT_A, BAR),
      },
    ], (row) => row.key.startsWith("attachment-")
      ? "unavailable"
      : "available");

    expect(projection).toMatchObject({
      state: "unavailable",
      evidenceState: "retained",
      statusText: "Some requirements are unavailable in saved equipment.",
    });
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows[0]).toMatchObject({
      key: `definition:${BAR}`,
      label: "Main bar",
      status: "available",
      statusText: "In saved equipment",
      classification: "confirmed",
      minWeight: 55,
      sourceExerciseIds: [EXERCISE_A, EXERCISE_B],
      sourceRequirementIds: [REQUIREMENT_A, EXACT_A, REQUIREMENT_B],
      usageContext: "Used for First exercise, Second exercise",
      requiredProfileKind: "plate_loaded_implement",
      requiresKnownGeometry: true,
    });
    expect(projection.rows[1]).toMatchObject({
      key: `attachment-definition:${ROPE}`,
      status: "unavailable",
      statusText: "Unavailable in saved equipment",
      classification: "attention",
      sourceRequirementIds: [EXACT_A],
    });
  });

  it("never merges same-label definitions and makes legacy or invalid evidence unknown", () => {
    const otherBar = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projection = projectSessionEquipmentPreparation([
      {
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "First",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot: snapshot(EXERCISE_A, REQUIREMENT_A, BAR),
      },
      {
        sessionExerciseId: SESSION_B,
        exerciseId: EXERCISE_B,
        exerciseLabel: "Second",
        orderIdx: 1,
        semanticsVersion: 1,
        snapshot: snapshot(EXERCISE_B, REQUIREMENT_B, otherBar),
      },
      {
        sessionExerciseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        exerciseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        exerciseLabel: "Legacy",
        orderIdx: 2,
        semanticsVersion: null,
        snapshot: null,
      },
    ], () => "available");

    expect(projection.evidenceState).toBe("partial_unknown");
    expect(projection.state).toBe("unknown");
    expect(projection.rows.filter((row) => row.label === "Main bar")).toHaveLength(2);
    expect(parseSessionEquipmentRequirementsEvidence(
      1,
      snapshot(EXERCISE_A, REQUIREMENT_A, BAR),
      EXERCISE_B,
    ).state).toBe("invalid");
  });

  it("treats a retained empty requirement set as known no-equipment truth", () => {
    const projection = projectSessionEquipmentPreparation([{
      sessionExerciseId: SESSION_A,
      exerciseId: EXERCISE_A,
      exerciseLabel: "Mobility",
      orderIdx: 0,
      semanticsVersion: 1,
      snapshot: { sourceExerciseId: EXERCISE_A, broad: [], exact: null },
    }], () => "available");
    expect(projection).toEqual({
      state: "available",
      statusText: "No equipment needed.",
      evidenceState: "retained",
      sourceHistoryRevision: null,
      rows: [],
    });
  });

  it("requires one primary item to satisfy every retained row for its type", () => {
    const requirements = [
      snapshot(EXERCISE_A, REQUIREMENT_A, BAR).broad[0],
      {
        ...snapshot(EXERCISE_B, REQUIREMENT_B, BAR).broad[0],
        equipmentDefinition: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          key: "other-bar",
          label: "Other bar",
        },
      },
    ];
    expect(retainedPrimaryEquipmentCandidateMatchesBroad(requirements, {
      equipmentType: "barbell",
      equipmentDefinitionId: BAR,
      attrs: { maxWeight: 500 },
    })).toBe(false);
    expect(retainedPrimaryEquipmentCandidateMatchesBroad(
      [requirements[0]],
      {
        equipmentType: "barbell",
        equipmentDefinitionId: BAR,
        attrs: { maxWeight: 45 },
      },
    )).toBe(true);
  });

  it("keeps exact profile and geometry predicates on a compatible broad row", () => {
    const projection = projectSessionEquipmentPreparation([{
      sessionExerciseId: SESSION_A,
      exerciseId: EXERCISE_A,
      exerciseLabel: "Plate-loaded pulldown",
      orderIdx: 0,
      semanticsVersion: 1,
      snapshot: {
        sourceExerciseId: EXERCISE_A,
        broad: [{
          sourceRequirementId: REQUIREMENT_A,
          equipmentType: "machine",
          equipmentDefinition: null,
          minWeight: null,
        }],
        exact: {
          sourceRequirementId: EXACT_A,
          requiredProfileKind: "plate_loaded_machine",
          requiredEquipmentDefinition: null,
          requiredAttachmentKind: null,
          requiredAttachmentDefinition: null,
          requiresKnownGeometry: true,
        },
      },
    }], (row) => row.requiredProfileKind === "plate_loaded_machine" &&
        row.requiresKnownGeometry
      ? "unavailable"
      : "available");

    expect(projection.rows).toEqual([expect.objectContaining({
      key: "type:machine",
      requiredProfileKind: "plate_loaded_machine",
      requiresKnownGeometry: true,
      status: "unavailable",
      sourceRequirementIds: [REQUIREMENT_A, EXACT_A],
    })]);
  });

  it("resolves an exact-only retained profile from saved candidates", () => {
    const exact = {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinition: null,
      requiredAttachmentKind: null,
      requiredAttachmentDefinition: null,
      requiresKnownGeometry: false,
    };
    const snapshot = {
      sourceExerciseId: EXERCISE_A,
      broad: [],
      exact,
    };
    const exactCandidates = [{
      equipmentItemId: BAR,
      equipmentType: "cable",
      equipmentDefinitionId: null,
      attrs: {},
      available: true,
      profileKind: "cable_machine",
      geometryCertainty: "unknown" as const,
      compatibleAttachments: [],
    }];
    const exactBySessionExercise = new Map([[SESSION_A, exact]]);
    const executable = retainedExerciseHasExecutableSetup({
      snapshot,
      inventory: exactCandidates,
      hasPlates: false,
      exactCandidates,
    });
    expect(executable).toBe(true);

    const projection = projectSessionEquipmentPreparation([{
      sessionExerciseId: SESSION_A,
      exerciseId: EXERCISE_A,
      exerciseLabel: "Exact cable exercise",
      orderIdx: 0,
      semanticsVersion: 1,
      snapshot,
    }], (row, sourceSessionExerciseIds) =>
      retainedExactRequirementRowHasSavedSetup({
        sourceRequirementIds: row.sourceRequirementIds,
        sourceSessionExerciseIds,
        exactRequirementsBySessionExerciseId: exactBySessionExercise,
        exactCandidates,
      }) && executable
        ? "available"
        : "unavailable");

    expect(projection).toMatchObject({
      state: "available",
      statusText: "Saved equipment covers this workout.",
    });
    expect(projection.rows).toEqual([expect.objectContaining({
      key: `exact-requirement:${EXACT_A}`,
      label: "cable machine",
      status: "available",
      statusText: "In saved equipment",
    })]);
  });

  it("keeps primary and attachment presence local before full compatibility", () => {
    const exact = {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinition: null,
      requiredAttachmentKind: "rope",
      requiredAttachmentDefinition: {
        id: ROPE,
        key: "saved-rope",
        label: "Saved rope",
      },
      requiresKnownGeometry: true,
    };
    const snapshot = {
      sourceExerciseId: EXERCISE_A,
      broad: [],
      exact,
    };
    const knownCable: RetainedExecutableSetupCandidate = {
      equipmentItemId: BAR,
      equipmentType: "cable",
      equipmentDefinitionId: null,
      attrs: {},
      available: true,
      profileKind: "cable_machine",
      geometryCertainty: "known" as const,
      compatibleAttachments: [],
    };
    const ropeCable: RetainedExecutableSetupCandidate = {
      equipmentItemId: OTHER_BAR,
      equipmentType: "cable",
      equipmentDefinitionId: null,
      attrs: {},
      available: true,
      profileKind: "cable_machine",
      geometryCertainty: "unknown" as const,
      compatibleAttachments: [{
        equipmentItemId: OTHER_ROPE,
        available: true,
        attachmentKind: "rope",
        equipmentDefinitionId: ROPE,
      }],
    };
    const exactBySessionExercise = new Map([[SESSION_A, exact]]);
    const savedRope: RetainedSavedAttachmentItem = {
      equipmentItemId: OTHER_ROPE,
      equipmentDefinitionId: ROPE,
      attachmentKind: "rope",
      available: true,
    };
    const project = (
      exactCandidates: RetainedExecutableSetupCandidate[],
      savedAttachments: RetainedSavedAttachmentItem[],
    ) => {
      const executable = retainedExerciseHasExecutableSetup({
        snapshot,
        inventory: exactCandidates,
        hasPlates: false,
        exactCandidates,
      });
      return projectSessionEquipmentPreparation([{
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "Split cable setup",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot,
      }], (row, sourceSessionExerciseIds) => {
        const present = row.key.startsWith("attachment-")
          ? retainedAttachmentRequirementHasSavedSetup({
              equipmentDefinitionId: row.equipmentDefinitionId,
              requiredAttachmentKind: row.requiredAttachmentKind,
              sourceSessionExerciseIds,
              exactRequirementsBySessionExerciseId: exactBySessionExercise,
              savedAttachments,
            })
          : retainedExactRequirementRowHasSavedSetup({
              sourceRequirementIds: row.sourceRequirementIds,
              sourceSessionExerciseIds,
              exactRequirementsBySessionExerciseId: exactBySessionExercise,
              exactCandidates,
            });
        return !present
          ? "unavailable"
          : executable
            ? "available"
            : "incompatible";
      });
    };

    const splitProjection = project([knownCable, ropeCable], [savedRope]);
    expect(splitProjection).toMatchObject({
      state: "unavailable",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(splitProjection.rows.map((row) => [row.label, row.status])).toEqual([
      ["cable machine", "incompatible"],
      ["Saved rope", "incompatible"],
    ]);

    const missingAttachment = project([knownCable], []);
    expect(missingAttachment).toMatchObject({
      state: "unavailable",
      statusText:
        "Some requirements are unavailable or have no compatible saved setup.",
    });
    expect(missingAttachment.rows.map((row) => [row.label, row.status])).toEqual([
      ["cable machine", "incompatible"],
      ["Saved rope", "unavailable"],
    ]);

    const unlinkedAttachment = project([knownCable], [savedRope]);
    expect(unlinkedAttachment).toMatchObject({
      state: "unavailable",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(unlinkedAttachment.rows.map((row) => [row.label, row.status]))
      .toEqual([
        ["cable machine", "incompatible"],
        ["Saved rope", "incompatible"],
      ]);
  });

  it("keeps satisfiable exact evidence incompatible with conflicting broad rows", () => {
    const definition = (id: string, label: string) => ({
      id,
      key: label.toLowerCase().replaceAll(" ", "-"),
      label,
    });
    const exact = {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "plate_loaded_implement",
      requiredEquipmentDefinition: null,
      requiredAttachmentKind: null,
      requiredAttachmentDefinition: null,
      requiresKnownGeometry: true,
    };
    const inventory = [
      {
        equipmentItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        equipmentType: "barbell",
        equipmentDefinitionId: BAR,
        attrs: {},
        available: true,
      },
      {
        equipmentItemId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        equipmentType: "barbell",
        equipmentDefinitionId: OTHER_BAR,
        attrs: {},
        available: true,
      },
    ];
    const exactCandidates = inventory.map((item) => ({
      ...item,
      profileKind: "plate_loaded_implement",
      geometryCertainty: "known" as const,
      compatibleAttachments: [],
    }));
    const snapshot = {
      sourceExerciseId: EXERCISE_A,
      broad: [
        {
          sourceRequirementId: REQUIREMENT_A,
          equipmentType: "barbell" as const,
          equipmentDefinition: definition(BAR, "Bar A"),
          minWeight: null,
        },
        {
          sourceRequirementId: REQUIREMENT_B,
          equipmentType: "barbell" as const,
          equipmentDefinition: definition(OTHER_BAR, "Bar B"),
          minWeight: null,
        },
      ],
      exact,
    };
    const exactBySessionExercise = new Map([[SESSION_A, exact]]);
    expect(retainedExactRequirementRowHasSavedSetup({
      sourceRequirementIds: [EXACT_A],
      sourceSessionExerciseIds: [SESSION_A],
      exactRequirementsBySessionExerciseId: exactBySessionExercise,
      exactCandidates,
    })).toBe(true);
    const executable = retainedExerciseHasExecutableSetup({
      snapshot,
      inventory,
      hasPlates: false,
      exactCandidates,
    });
    expect(executable).toBe(false);

    const projection = projectSessionEquipmentPreparation([{
      sessionExerciseId: SESSION_A,
      exerciseId: EXERCISE_A,
      exerciseLabel: "Conflicting exact bars",
      orderIdx: 0,
      semanticsVersion: 1,
      snapshot,
    }], (row, sourceSessionExerciseIds) => {
      const saved = row.key.startsWith("exact-requirement:")
        ? retainedExactRequirementRowHasSavedSetup({
            sourceRequirementIds: row.sourceRequirementIds,
            sourceSessionExerciseIds,
            exactRequirementsBySessionExerciseId: exactBySessionExercise,
            exactCandidates,
          })
        : true;
      return !saved ? "unavailable" : executable ? "available" : "incompatible";
    });

    expect(projection).toMatchObject({
      state: "unavailable",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(projection.rows).toHaveLength(3);
    expect(projection.rows.every((row) => row.status === "incompatible"))
      .toBe(true);
  });

  it("requires one coherent setup for conflicting broad and exact definitions", () => {
    const definition = (id: string, label: string) => ({
      id,
      key: label.toLowerCase().replaceAll(" ", "-"),
      label,
    });
    const broadA = {
      sourceRequirementId: REQUIREMENT_A,
      equipmentType: "barbell" as const,
      equipmentDefinition: definition(BAR, "Bar A"),
      minWeight: null,
    };
    const broadB = {
      sourceRequirementId: REQUIREMENT_B,
      equipmentType: "barbell" as const,
      equipmentDefinition: definition(OTHER_BAR, "Bar B"),
      minWeight: null,
    };
    const inventory = [
      {
        equipmentItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        equipmentType: "barbell",
        equipmentDefinitionId: BAR,
        attrs: {},
        available: true,
      },
      {
        equipmentItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        equipmentType: "barbell",
        equipmentDefinitionId: OTHER_BAR,
        attrs: {},
        available: true,
      },
    ];
    const exactCandidates = inventory.map((item) => ({
      ...item,
      profileKind: "plate_loaded_implement",
      geometryCertainty: "known" as const,
      compatibleAttachments: [],
    }));

    expect(retainedExerciseHasExecutableSetup({
      snapshot: {
        sourceExerciseId: EXERCISE_A,
        broad: [broadA, broadB],
        exact: null,
      },
      inventory,
      hasPlates: false,
      exactCandidates,
    })).toBe(false);

    expect(retainedExerciseHasExecutableSetup({
      snapshot: {
        sourceExerciseId: EXERCISE_A,
        broad: [broadA],
        exact: {
          sourceRequirementId: EXACT_A,
          requiredProfileKind: "plate_loaded_implement",
          requiredEquipmentDefinition: definition(OTHER_BAR, "Bar B"),
          requiredAttachmentKind: null,
          requiredAttachmentDefinition: null,
          requiresKnownGeometry: true,
        },
      },
      inventory,
      hasPlates: false,
      exactCandidates,
    })).toBe(false);
  });

  it("keeps repeated source requirement IDs isolated by session exercise", () => {
    const definition = (id: string, label: string) => ({
      id,
      key: label.toLowerCase().replaceAll(" ", "-"),
      label,
    });
    const exactA = {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinition: definition(BAR, "Cable A"),
      requiredAttachmentKind: "rope",
      requiredAttachmentDefinition: definition(ROPE, "Rope A"),
      requiresKnownGeometry: true,
    };
    const exactB = {
      ...exactA,
      requiredEquipmentDefinition: definition(OTHER_BAR, "Cable B"),
      requiredAttachmentDefinition: definition(OTHER_ROPE, "Rope B"),
    };
    const exactBySessionExercise = new Map([
      [SESSION_A, exactA],
      [SESSION_B, exactB],
    ]);
    const exactCandidates = [
      {
        equipmentItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        equipmentType: "cable",
        equipmentDefinitionId: BAR,
        attrs: {},
        available: true,
        profileKind: "cable_machine",
        geometryCertainty: "known" as const,
        compatibleAttachments: [{
          equipmentItemId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          available: true,
          attachmentKind: "rope",
          equipmentDefinitionId: ROPE,
        }],
      },
      {
        equipmentItemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        equipmentType: "cable",
        equipmentDefinitionId: OTHER_BAR,
        attrs: {},
        available: true,
        profileKind: "cable_machine",
        geometryCertainty: "known" as const,
        compatibleAttachments: [{
          equipmentItemId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          available: true,
          attachmentKind: "rope",
          equipmentDefinitionId: OTHER_ROPE,
        }],
      },
    ];
    const projection = projectSessionEquipmentPreparation([
      {
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "Cable revision A",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot: {
          sourceExerciseId: EXERCISE_A,
          broad: [{
            sourceRequirementId: REQUIREMENT_A,
            equipmentType: "cable",
            equipmentDefinition: definition(BAR, "Cable A"),
            minWeight: null,
          }],
          exact: exactA,
        },
      },
      {
        sessionExerciseId: SESSION_B,
        exerciseId: EXERCISE_A,
        exerciseLabel: "Cable revision B",
        orderIdx: 1,
        semanticsVersion: 1,
        snapshot: {
          sourceExerciseId: EXERCISE_A,
          broad: [{
            sourceRequirementId: REQUIREMENT_A,
            equipmentType: "cable",
            equipmentDefinition: definition(OTHER_BAR, "Cable B"),
            minWeight: null,
          }],
          exact: exactB,
        },
      },
    ], (row, sourceSessionExerciseIds) =>
      row.key.startsWith("attachment-")
        ? retainedAttachmentRequirementHasSavedSetup({
            equipmentDefinitionId: row.equipmentDefinitionId,
            requiredAttachmentKind: row.requiredAttachmentKind,
            sourceSessionExerciseIds,
            exactRequirementsBySessionExerciseId: exactBySessionExercise,
            savedAttachments: exactCandidates.flatMap(
              (candidate) => candidate.compatibleAttachments,
            ),
          })
          ? "available"
          : "unavailable"
        : "available");

    expect(projection).toMatchObject({
      state: "available",
      evidenceState: "retained",
      statusText: "Saved equipment covers this workout.",
    });
    expect(projection.rows.map((row) => [row.label, row.status])).toEqual([
      ["Cable A", "available"],
      ["Rope A", "available"],
      ["Cable B", "available"],
      ["Rope B", "available"],
    ]);
  });

  it("proves shared primary rows from each frozen revision, not merged fields", () => {
    const definition = {
      id: BAR,
      key: "shared-station",
      label: "Shared station",
    };
    const exactA = {
      sourceRequirementId: EXACT_A,
      requiredProfileKind: "cable_machine",
      requiredEquipmentDefinition: definition,
      requiredAttachmentKind: null,
      requiredAttachmentDefinition: null,
      requiresKnownGeometry: true,
    };
    const exactB = {
      ...exactA,
      requiredProfileKind: "plate_loaded_machine",
    };
    const snapshotA = {
      sourceExerciseId: EXERCISE_A,
      broad: [],
      exact: exactA,
    };
    const snapshotB = {
      sourceExerciseId: EXERCISE_B,
      broad: [],
      exact: exactB,
    };
    const cableCandidate: RetainedExecutableSetupCandidate = {
      equipmentItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      equipmentType: "cable",
      equipmentDefinitionId: BAR,
      attrs: {},
      available: true,
      profileKind: "cable_machine",
      geometryCertainty: "known",
      compatibleAttachments: [],
    };
    const machineCandidate: RetainedExecutableSetupCandidate = {
      ...cableCandidate,
      equipmentItemId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      equipmentType: "machine",
      profileKind: "plate_loaded_machine",
    };
    const snapshotsBySessionExercise = new Map([
      [SESSION_A, snapshotA],
      [SESSION_B, snapshotB],
    ]);
    const sourceSessionExerciseIds = [SESSION_A, SESSION_B];
    expect(retainedPrimaryRequirementRowHasSavedSetup({
      rowKey: `definition:${BAR}`,
      sourceSessionExerciseIds,
      snapshotsBySessionExerciseId: snapshotsBySessionExercise,
      inventory: [cableCandidate],
      hasPlates: false,
      exactCandidates: [cableCandidate],
    })).toBe(false);
    expect(retainedPrimaryRequirementRowHasSavedSetup({
      rowKey: `definition:${BAR}`,
      sourceSessionExerciseIds,
      snapshotsBySessionExerciseId: snapshotsBySessionExercise,
      inventory: [cableCandidate, machineCandidate],
      hasPlates: false,
      exactCandidates: [cableCandidate, machineCandidate],
    })).toBe(true);

    const executableBySessionExercise = new Map([
      [SESSION_A, retainedExerciseHasExecutableSetup({
        snapshot: snapshotA,
        inventory: [cableCandidate],
        hasPlates: false,
        exactCandidates: [cableCandidate],
      })],
      [SESSION_B, retainedExerciseHasExecutableSetup({
        snapshot: snapshotB,
        inventory: [cableCandidate],
        hasPlates: false,
        exactCandidates: [cableCandidate],
      })],
    ]);
    const projection = projectSessionEquipmentPreparation([
      {
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "Cable revision",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot: snapshotA,
      },
      {
        sessionExerciseId: SESSION_B,
        exerciseId: EXERCISE_B,
        exerciseLabel: "Machine revision",
        orderIdx: 1,
        semanticsVersion: 1,
        snapshot: snapshotB,
      },
    ], (row, contributorIds) => {
      const present = retainedPrimaryRequirementRowHasSavedSetup({
        rowKey: row.key,
        sourceSessionExerciseIds: contributorIds,
        snapshotsBySessionExerciseId: snapshotsBySessionExercise,
        inventory: [cableCandidate],
        hasPlates: false,
        exactCandidates: [cableCandidate],
      });
      if (!present) return "unavailable";
      return contributorIds.every((id) =>
        executableBySessionExercise.get(id) === true
      ) ? "available" : "incompatible";
    });

    expect(projection.rows).toEqual([expect.objectContaining({
      key: `definition:${BAR}`,
      status: "unavailable",
      statusText: "Unavailable in saved equipment",
    })]);
  });

  it("marks a saved shared row incompatible when any source exercise is not executable", () => {
    const noExactA = structuredClone(snapshot(
      EXERCISE_A,
      REQUIREMENT_A,
      BAR,
    ));
    noExactA.exact = null;
    const projection = projectSessionEquipmentPreparation([
      {
        sessionExerciseId: SESSION_A,
        exerciseId: EXERCISE_A,
        exerciseLabel: "First",
        orderIdx: 0,
        semanticsVersion: 1,
        snapshot: noExactA,
      },
      {
        sessionExerciseId: SESSION_B,
        exerciseId: EXERCISE_B,
        exerciseLabel: "Second",
        orderIdx: 1,
        semanticsVersion: 1,
        snapshot: snapshot(EXERCISE_B, REQUIREMENT_B, BAR),
      },
    ], (_row, sourceSessionExerciseIds) =>
      sourceSessionExerciseIds.every((id) => id !== SESSION_B)
        ? "available"
        : "incompatible");

    expect(projection).toMatchObject({
      state: "unavailable",
      statusText:
        "Saved equipment is present, but no compatible setup covers this workout.",
    });
    expect(projection.rows).toEqual([expect.objectContaining({
      key: `definition:${BAR}`,
      status: "incompatible",
      statusText: "No compatible saved setup",
      classification: "attention",
    })]);
  });

  it("keeps owned broad cable present when its exact profile is incomplete", () => {
    const retained: SessionEquipmentRequirementsSnapshot = {
      sourceExerciseId: EXERCISE_A,
      broad: [{
        sourceRequirementId: REQUIREMENT_A,
        equipmentType: "cable",
        equipmentDefinition: null,
        minWeight: null,
      }],
      exact: {
        sourceRequirementId: EXACT_A,
        requiredProfileKind: "cable_machine",
        requiredEquipmentDefinition: null,
        requiredAttachmentKind: "lat_bar",
        requiredAttachmentDefinition: null,
        requiresKnownGeometry: true,
      },
    };
    const savedCable = {
      equipmentItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      equipmentType: "cable",
      equipmentDefinitionId: null,
      attrs: {},
      available: true,
    };
    const snapshots = new Map([[SESSION_A, retained]]);

    expect(retainedPrimaryRequirementRowHasSavedSetup({
      rowKey: "type:cable",
      sourceSessionExerciseIds: [SESSION_A],
      snapshotsBySessionExerciseId: snapshots,
      inventory: [savedCable],
      hasPlates: false,
      exactCandidates: [],
    })).toBe(true);
    expect(retainedExerciseHasExecutableSetup({
      snapshot: retained,
      inventory: [savedCable],
      hasPlates: false,
      exactCandidates: [],
    })).toBe(false);
    expect(retainedPrimaryRequirementRowHasSavedSetup({
      rowKey: "type:cable",
      sourceSessionExerciseIds: [SESSION_A],
      snapshotsBySessionExerciseId: snapshots,
      inventory: [],
      hasPlates: false,
      exactCandidates: [],
    })).toBe(false);
  });

  it("distinguishes a saved incompatible row from a missing requirement", () => {
    const projection = projectSessionEquipmentPreparation([{
      sessionExerciseId: SESSION_A,
      exerciseId: EXERCISE_A,
      exerciseLabel: "Bench cable exercise",
      orderIdx: 0,
      semanticsVersion: 1,
      snapshot: {
        sourceExerciseId: EXERCISE_A,
        broad: [
          {
            sourceRequirementId: REQUIREMENT_A,
            equipmentType: "bench",
            equipmentDefinition: null,
            minWeight: null,
          },
          {
            sourceRequirementId: REQUIREMENT_B,
            equipmentType: "cable",
            equipmentDefinition: null,
            minWeight: null,
          },
        ],
        exact: null,
      },
    }], (row) => row.equipmentType === "bench"
      ? "incompatible"
      : "unavailable");

    expect(projection).toMatchObject({
      state: "unavailable",
      statusText:
        "Some requirements are unavailable or have no compatible saved setup.",
    });
    expect(projection.rows.map((row) => ({
      label: row.label,
      status: row.status,
      statusText: row.statusText,
    }))).toEqual([
      {
        label: "bench",
        status: "incompatible",
        statusText: "No compatible saved setup",
      },
      {
        label: "cable station",
        status: "unavailable",
        statusText: "Unavailable in saved equipment",
      },
    ]);
  });
});
